;;; malebolge-ert.el --- ERT suite for the Emacs attach client -*- lexical-binding: t; -*-

;;; Commentary:

;; Headless, daemon-free tests for `emacs/malebolge.el'.  Run with:
;;
;;   emacs --batch -Q -L emacs -l ert -l test/malebolge-ert.el \
;;         -f ert-run-tests-batch-and-exit
;;
;; or `just ert'.
;;
;; ASSUMED API (PHASE-03; the implementation must provide these names):
;;
;; - `malebolge-attach' starts `malebolge-attach-command' plus "--emacs" in
;;   the transcript buffer `malebolge-buffer-name' ("*malebolge*"), whose
;;   major mode is `malebolge-transcript-mode' (derived from `comint-mode'),
;;   and creates the companion draft buffer `malebolge-draft-buffer-name'
;;   ("*malebolge-draft*") in `malebolge-draft-mode' (derived from
;;   `text-mode').
;; - Draft bindings: C-c C-c `malebolge-submit', C-c C-a `malebolge-abort',
;;   C-c C-m `malebolge-compact' (optional instructions via `read-string'),
;;   C-c C-q `malebolge-quit', C-c C-h `malebolge-help'.
;; - Transcript bindings: the same five controls plus C-c C-e
;;   `malebolge-draft' (show/focus the draft); `RET' focuses the draft.
;; - Frames are newline-terminated JSON written with `process-send-string':
;;   {"type":"input","content":...}, {"type":"abort"}, {"type":"compact",
;;   "instructions":...}, {"type":"quit"}.
;; - Faces `malebolge-tool-face' (transcript lines starting "[tool] ") and
;;   `malebolge-status-face' (lines starting "[status] ").
;; - `header-line-format' is non-nil in both buffers.

;;; Code:

(require 'ert)
(require 'cl-lib)
(require 'json)

(let ((here (file-name-directory (or load-file-name buffer-file-name))))
  (load (expand-file-name "../emacs/malebolge.el" here) nil t))

;;; Fixtures

(defvar malebolge-test--capture-file nil
  "Temp file the fake attach process writes its stdin to.")

(defun malebolge-test--capture-bytes ()
  "Return the raw bytes the fake process has received so far."
  (when (and malebolge-test--capture-file
             (file-exists-p malebolge-test--capture-file))
    (with-temp-buffer
      (set-buffer-multibyte nil)
      (insert-file-contents-literally malebolge-test--capture-file)
      (buffer-string))))

(defun malebolge-test--wait ()
  "Pump process output until the fake process has copied everything it can."
  (let ((deadline (+ (float-time) 5)))
    (while (and (accept-process-output nil 0.05)
                (< (float-time) deadline)))))

(defun malebolge-test--frames ()
  "Return the captured bytes as a list of JSON strings, one per line."
  (let ((bytes (or (malebolge-test--capture-bytes) "")))
    (when (stringp bytes)
      (split-string bytes "\n" t))))

(defun malebolge-test--frame-values ()
  "Return captured lines decoded with `json-parse-string'."
  (mapcar (lambda (line) (json-parse-string line :object-type 'alist))
          (malebolge-test--frames)))

(defun malebolge-test--make-fake ()
  "Create the fake attach process, copying stdin into the capture file."
  (setq malebolge-test--capture-file
        (make-temp-file "malebolge-ert-" nil ".stdin"))
  (make-process
   :name "malebolge-test-fake"
   :buffer (current-buffer)
   :filter #'comint-output-filter
   :noquery t
   :connection-type 'pipe
   :command (list "sh" "-c" "cat > \"$0\"" malebolge-test--capture-file)))

(defmacro malebolge-test--with-session (&rest body)
  "Run BODY with a live fake process, a transcript and a draft buffer.
BODY may use `malebolge-test--capture-file', `malebolge-test--wait',
`malebolge-test--frames', `malebolge-test--frame-values', and the
let-bound variables `transcript' and `draft'.  Both buffers are
created by `malebolge-attach' against the fake process."
  (declare (indent 0) (debug t))
  `(let* ((malebolge-attach-command (list "true"))
          (malebolge-test--capture-file nil)
          (draft-buffer-name (and (boundp 'malebolge-draft-buffer-name)
                                  malebolge-draft-buffer-name))
          (transcript nil)
          (draft nil))
     (unwind-protect
         (progn
           (when (get-buffer malebolge-buffer-name)
             (kill-buffer malebolge-buffer-name))
           (when (and draft-buffer-name (get-buffer draft-buffer-name))
             (kill-buffer draft-buffer-name))
           (cl-letf (((symbol-function 'make-comint-in-buffer)
                      (lambda (_name buffer &rest _args)
                        (with-current-buffer buffer
                          (malebolge-test--make-fake)))))
             (malebolge-attach))
           (setq transcript (get-buffer malebolge-buffer-name)
                 draft (and draft-buffer-name (get-buffer draft-buffer-name)))
           ,@body)
       (dolist (buf (list draft transcript))
         (when (buffer-live-p buf)
           (let ((proc (get-buffer-process buf)))
             (when (process-live-p proc) (delete-process proc)))
           (kill-buffer buf)))
       (when (and malebolge-test--capture-file
                  (file-exists-p malebolge-test--capture-file))
         (delete-file malebolge-test--capture-file)))))

(defun malebolge-test--insert-draft (text)
  "Replace the draft buffer text with TEXT, leaving point at end."
  (with-current-buffer malebolge-draft-buffer-name
    (erase-buffer)
    (insert text)
    (goto-char (point-max))))

(defun malebolge-test--draft-text ()
  "Return the draft buffer text."
  (with-current-buffer malebolge-draft-buffer-name (buffer-string)))

(defun malebolge-test--submit ()
  "Submit the draft from within the draft buffer."
  (with-current-buffer malebolge-draft-buffer-name
    (call-interactively #'malebolge-submit)))

;;; EX-1: framed submit

(ert-deftest malebolge-submit-writes-one-input-frame ()
  "C-c C-c writes exactly one input frame with the verbatim draft text."
  (malebolge-test--with-session
    (let ((text "  lead\n\n/slash\ntrail  "))
      (malebolge-test--insert-draft text)
      (malebolge-test--submit)
      (malebolge-test--wait)
      (let ((frames (malebolge-test--frames)))
        (should (= 1 (length frames)))
        (should (string-suffix-p "\n" (malebolge-test--capture-bytes)))
        (let ((frame (car (malebolge-test--frame-values))))
          (should (equal "input" (alist-get 'type frame)))
          (should (equal text (alist-get 'content frame)))))
      (should (equal "" (malebolge-test--draft-text))))))

(ert-deftest malebolge-submit-refuses-whitespace-only-draft ()
  "An all-whitespace draft is refused and written nowhere."
  (malebolge-test--with-session
    (let ((text " \n\t\n  "))
      (malebolge-test--insert-draft text)
      (should-error (malebolge-test--submit) :type 'user-error)
      (malebolge-test--wait)
      (should (= 0 (length (malebolge-test--frames))))
      (should (equal text (malebolge-test--draft-text))))))

(ert-deftest malebolge-submit-from-transcript-sends-the-draft ()
  "Submitting with the transcript current sends the draft, untouched transcript."
  (malebolge-test--with-session
    (let ((text "the draft, not the transcript"))
      (malebolge-test--insert-draft text)
      (with-current-buffer transcript
        (goto-char (point-max))
        (let ((before (buffer-string)))
          (call-interactively #'malebolge-submit)
          (malebolge-test--wait)
          (should (equal before (buffer-string)))))
      (let ((frames (malebolge-test--frames)))
        (should (= 1 (length frames)))
        (let ((frame (car (malebolge-test--frame-values))))
          (should (equal "input" (alist-get 'type frame)))
          (should (equal text (alist-get 'content frame)))))
      (should (equal "" (malebolge-test--draft-text))))))

(ert-deftest malebolge-transcript-refuses-comint-eof-and-signal-keys ()
  "C-d, C-c C-d, C-c C-z and C-c C-\\\\ signal and write nothing."
  (malebolge-test--with-session
    (dolist (key (list (kbd "C-d") (kbd "C-c C-d") (kbd "C-c C-z") (kbd "C-c C-\\")))
      (with-current-buffer transcript
        (goto-char (point-max))
        (let ((binding (key-binding key)))
          (should binding)
          (should-error (call-interactively binding) :type 'user-error))))
    (malebolge-test--wait)
    (should (= 0 (length (malebolge-test--frames))))
    (should (process-live-p (get-buffer-process transcript)))))

(ert-deftest malebolge-compact-without-instructions-sends-type-only ()
  "A non-interactive `malebolge-compact' sends {\"type\":\"compact\"}."
  (malebolge-test--with-session
    (malebolge-compact)
    (malebolge-test--wait)
    (should (equal "{\"type\":\"compact\"}\n" (malebolge-test--capture-bytes)))
    (should-not (assq 'instructions (car (malebolge-test--frame-values))))))

(ert-deftest malebolge-submit-refuses-dead-process ()
  "With a dead process, submit errors and leaves the draft intact."
  (malebolge-test--with-session
    (let ((text "keep me"))
      (malebolge-test--insert-draft text)
      (delete-process (get-buffer-process transcript))
      (should-error (malebolge-test--submit) :type 'user-error)
      (should (equal text (malebolge-test--draft-text))))))

;;; EX-2: local editing never submits

(ert-deftest malebolge-session-fixture-is-live ()
  "The fixture itself provides a live process and both buffers."
  (malebolge-test--with-session
    (should (buffer-live-p transcript))
    (should (process-live-p (get-buffer-process transcript)))
    (should (buffer-live-p draft))
    (should (eq (with-current-buffer transcript major-mode)
                'malebolge-transcript-mode))
    (should (eq (with-current-buffer draft major-mode)
                'malebolge-draft-mode))))

(ert-deftest malebolge-draft-ret-and-yank-do-not-submit ()
  "RET and yanking multi-line text in the draft write nothing."
  (malebolge-test--with-session
    (with-current-buffer draft
      (erase-buffer)
      (insert "  lead")
      ;; Call RET through its binding: `execute-kbd-macro' does not deliver
      ;; RET faithfully under `--batch'.
      (call-interactively (key-binding (kbd "RET")))
      (insert "/slash")
      (call-interactively (key-binding (kbd "RET")))
      (insert "trail")
      (cl-letf (((symbol-function 'current-kill)
                 (lambda (&rest _) "line one\nline two\n")))
        (yank))
      (malebolge-test--wait)
      (should (= 0 (length (malebolge-test--frames))))
      (should (string-suffix-p "line one\nline two\n" (buffer-string))))))

(ert-deftest malebolge-transcript-ret-and-comint-send-input-write-nothing ()
  "RET and `comint-send-input' in the transcript write zero bytes."
  (malebolge-test--with-session
    (with-current-buffer transcript
      (goto-char (point-max))
      (let ((inhibit-read-only t)) (insert "typed text"))
      (execute-kbd-macro (kbd "RET"))
      (let ((inhibit-read-only t)) (goto-char (point-max)) (insert "typed text"))
      (should-error (comint-send-input) :type 'user-error)
      (malebolge-test--wait)
      (should (= 0 (length (malebolge-test--frames))))
      ;; Focus should have moved to the draft when the draft exists.
      (when (buffer-live-p draft)
        (should (eq (window-buffer (selected-window)) draft))))))

;;; EX-3: controls send frames and preserve the draft

(ert-deftest malebolge-abort-compact-quit-send-frames ()
  "Abort, compact and quit write their frames and never clear the draft."
  (malebolge-test--with-session
    (let ((text "draft survives"))
      (malebolge-test--insert-draft text)
      (with-current-buffer draft
        (call-interactively #'malebolge-abort)
        (malebolge-test--wait)
        (let ((frame (car (malebolge-test--frame-values))))
          (should (equal "abort" (alist-get 'type frame)))))
      (should (equal text (malebolge-test--draft-text)))

      (malebolge-test--insert-draft text)
      (with-current-buffer draft
        (cl-letf (((symbol-function 'read-string) (lambda (&rest _) "be brief")))
          (call-interactively #'malebolge-compact)))
      (malebolge-test--wait)
      (let ((frame (car (last (malebolge-test--frame-values)))))
        (should (equal "compact" (alist-get 'type frame)))
        (should (equal "be brief" (alist-get 'instructions frame))))
      (should (equal text (malebolge-test--draft-text)))

      (malebolge-test--insert-draft text)
      (with-current-buffer draft
        (cl-letf (((symbol-function 'read-string) (lambda (&rest _) "")))
          (call-interactively #'malebolge-compact)))
      (malebolge-test--wait)
      (let ((frame (car (last (malebolge-test--frame-values)))))
        (should (equal "compact" (alist-get 'type frame)))
        (should-not (assq 'instructions frame)))
      (should (equal text (malebolge-test--draft-text)))

      (malebolge-test--insert-draft text)
      (with-current-buffer draft
        (call-interactively #'malebolge-quit))
      (malebolge-test--wait)
      (let ((frame (car (last (malebolge-test--frame-values)))))
        (should (equal "quit" (alist-get 'type frame))))
      (should (equal text (malebolge-test--draft-text))))))

;;; EX-3: buffer-local bindings

(ert-deftest malebolge-key-bindings-are-mode-local ()
  "Both mode maps bind the documented controls, without touching comint."
  (malebolge-test--with-session
    (dolist (buf (list draft transcript))
      (with-current-buffer buf
        (should (eq (lookup-key (current-local-map) (kbd "C-c C-c"))
                    'malebolge-submit))
        (should (eq (lookup-key (current-local-map) (kbd "C-c C-a"))
                    'malebolge-abort))
        (should (eq (lookup-key (current-local-map) (kbd "C-c C-m"))
                    'malebolge-compact))
        (should (eq (lookup-key (current-local-map) (kbd "C-c C-q"))
                    'malebolge-quit))
        (should (eq (lookup-key (current-local-map) (kbd "C-c C-h"))
                    'malebolge-help))))
    (with-current-buffer transcript
      (should (eq (lookup-key (current-local-map) (kbd "C-c C-e"))
                  'malebolge-draft))
      (should (eq (lookup-key (current-local-map) (kbd "RET"))
                  'malebolge-draft)))
    (should-not (eq (lookup-key comint-mode-map (kbd "C-c C-c"))
                    'malebolge-submit))))

;;; EX-4: cues, help, draft lifetime

(ert-deftest malebolge-header-lines-and-help ()
  "Both buffers show a header line; help names the submit binding."
  (malebolge-test--with-session
    (dolist (buf (list draft transcript))
      (with-current-buffer buf
        (should header-line-format)
        (should (string-match-p "C-c C-h" header-line-format))))
    (let ((help (with-current-buffer draft
                  (cl-letf (((symbol-function 'display-buffer)
                             (lambda (buf &rest _) buf))
                            ((symbol-function 'message) #'ignore)
                            ;; `with-help-window' needs a live window, which
                            ;; `--batch' has none of; give it the selected one.
                            ((symbol-function 'temp-buffer-window-show)
                             (lambda (_buf &rest _) (selected-window))))
                    (call-interactively #'malebolge-help))
                  (with-current-buffer (help-buffer)
                    (let ((text (buffer-string)))
                      (setq buffer-read-only nil)
                      text)))))
      (should (string-match-p "C-c C-c" help))
      (kill-buffer (help-buffer)))))

(ert-deftest malebolge-draft-survives-process-exit ()
  "The draft, and its text, outlive the attach process."
  (malebolge-test--with-session
    (malebolge-test--insert-draft "still here")
    (delete-process (get-buffer-process transcript))
    (malebolge-test--wait)
    (should (buffer-live-p draft))
    (should (equal "still here" (malebolge-test--draft-text)))))

(ert-deftest malebolge-draft-never-receives-process-output ()
  "Transcript output leaves the draft untouched."
  (malebolge-test--with-session
    (malebolge-test--insert-draft "my draft")
    (let ((before (malebolge-test--draft-text)))
      (with-current-buffer transcript
        (when (fboundp 'comint-output-filter)
          (let ((proc (get-buffer-process transcript)))
            (when (process-live-p proc)
              (comint-output-filter proc "streamed assistant text\n")))))
      (malebolge-test--wait)
      (should (equal before (malebolge-test--draft-text)))
      (should (string-search "streamed assistant text"
                             (with-current-buffer transcript (buffer-string)))))))

;;; EX-6: transcript faces

(ert-deftest malebolge-transcript-faces-distinguish-labels ()
  "Tool and status lines carry their faces; plain lines carry neither."
  (malebolge-test--with-session
    (with-current-buffer transcript
      (let ((start (point-max)))
        (comint-output-filter (get-buffer-process (current-buffer))
                              "[tool] grep {}\n[status] connected\nplain\n")
        (goto-char start)
        (when (fboundp 'font-lock-ensure)
          (let ((font-lock-support-mode nil))
            (font-lock-ensure)))
        (let* ((tool-pos (+ start 1))
               (status-pos (save-excursion
                             (goto-char start)
                             (search-forward "[status]")
                             (line-beginning-position)))
               (plain-pos (save-excursion
                            (goto-char start)
                            (search-forward "plain")
                            (line-beginning-position)))
               (face-at (lambda (pos)
                          (or (get-text-property pos 'face)
                              (get-text-property pos 'font-lock-face)))))
          (should (memq 'malebolge-tool-face
                        (list (funcall face-at tool-pos))))
          (should (memq 'malebolge-status-face
                        (list (funcall face-at status-pos))))
          (should-not (memq 'malebolge-tool-face
                            (list (funcall face-at plain-pos))))
          (should-not (memq 'malebolge-status-face
                            (list (funcall face-at plain-pos)))))))))

;;; EX-5: output following is per window

(defun malebolge-test--feed (text)
  "Insert TEXT into the transcript through its comint output filter."
  (with-current-buffer malebolge-buffer-name
    (let ((proc (get-buffer-process (current-buffer))))
      (if (process-live-p proc)
          (comint-output-filter proc text)
        (let ((inhibit-read-only t)) (goto-char (point-max)) (insert text))))))

(defun malebolge-test--feed-lines (count)
  "Insert COUNT numbered output lines through the real output filter."
  (dotimes (i count)
    (malebolge-test--feed (format "line %03d\n" i))))

(defun malebolge-test--redisplay ()
  "Force a redisplay so window-start/point reflect the inserted text.
In `--batch' there is a frame, but no idle redisplay, so window state is
only recomputed when we ask for it explicitly."
  (redisplay t)
  (sit-for 0))

(defmacro malebolge-test--with-transcript-frame (&rest body)
  "Run BODY with a frame sized for two transcript windows and a draft window.
BODY sees `w1' (the transcript window kept at the end) and `w2' (a
transcript window reading older text); the draft window stays selected."
  (declare (indent 0) (debug t))
  `(let ((frame (selected-frame)))
     (set-frame-size frame 80 20)
     (unwind-protect
         (progn ,@body)
       (delete-other-windows))))

(ert-deftest malebolge-transcript-disables-scroll-to-bottom ()
  "The transcript does not auto-scroll comint to the bottom on output."
  (malebolge-test--with-session
    (with-current-buffer transcript
      (should-not comint-scroll-to-bottom-on-output))))

(ert-deftest malebolge-follow-only-windows-at-end ()
  "Only transcript windows showing the old end follow new output."
  (malebolge-test--with-session
    (malebolge-test--with-transcript-frame
      (malebolge-test--insert-draft "draft stays put")
      (malebolge-test--feed-lines 200)
      (malebolge-test--redisplay)
      (delete-other-windows)
      (set-window-buffer (selected-window) draft)
      (let* ((draft-window (selected-window))
             (w1 (split-window-below))
             (w2 (split-window-below)))
        (set-window-buffer w1 transcript)
        (set-window-buffer w2 transcript)
        ;; W1 sits at the end of the transcript; W2 reads older text.
        (set-window-point w1 (point-max))
        (with-current-buffer transcript
          (set-window-start w1 (max (point-min) (- (point-max) 4))))
        (set-window-point w2 (point-min))
        (set-window-start w2 (point-min))
        (select-window draft-window)
        (malebolge-test--redisplay)
        (let ((w2-start (window-start w2))
              (w2-point (window-point w2)))
          (malebolge-test--feed-lines 5)
          (malebolge-test--redisplay)
          (let ((end (with-current-buffer transcript (point-max))))
            (should (= end (window-point w1)))
            (should (= w2-start (window-start w2)))
            (should (= w2-point (window-point w2))))
          (should (eq draft (window-buffer (selected-window))))
          (should (eq (selected-window) draft-window)))))))

;;; EX-5: reattachment

(ert-deftest malebolge-reattach-live-reuses-buffers ()
  "Attaching to a live process reuses the process and the transcript."
  (malebolge-test--with-session
    (malebolge-test--feed "hello again\n")
    (let ((proc (get-buffer-process transcript))
          (text (with-current-buffer transcript (buffer-string))))
      (malebolge-attach)
      (should (eq proc (get-buffer-process transcript)))
      (should (equal text (with-current-buffer transcript (buffer-string))))
      (should (eq transcript (get-buffer malebolge-buffer-name)))
      (should (eq draft (get-buffer malebolge-draft-buffer-name))))))

(ert-deftest malebolge-reattach-dead-clears-transcript-keeps-draft ()
  "A dead-process reattach clears the transcript before restarting."
  (malebolge-test--with-session
    (malebolge-test--feed "old snapshot\n")
    (malebolge-test--insert-draft "keep me")
    (delete-process (get-buffer-process transcript))
    (let ((seen nil))
      (cl-letf (((symbol-function 'make-comint-in-buffer)
                 (lambda (_name buffer &rest _args)
                   (setq seen (with-current-buffer buffer (buffer-string)))
                   (with-current-buffer buffer (malebolge-test--make-fake)))))
        (malebolge-attach))
      (should seen)
      (should (equal "" seen)))
    (should (equal "keep me" (malebolge-test--draft-text)))
    (should (process-live-p (get-buffer-process transcript)))
    (should-not (string-match-p "old snapshot"
                                (with-current-buffer transcript
                                  (buffer-string))))))

(ert-deftest malebolge-reattach-failure-keeps-draft ()
  "A failed process start reports a status line and keeps the draft."
  (malebolge-test--with-session
    (malebolge-test--feed "old snapshot\n")
    (malebolge-test--insert-draft "survives")
    (delete-process (get-buffer-process transcript))
    (cl-letf (((symbol-function 'make-comint-in-buffer)
               (lambda (&rest _)
                 (signal 'file-missing '("Opening process input file" "nope")))))
      (ignore-errors (malebolge-attach)))
    (should (equal "survives" (malebolge-test--draft-text)))
    (with-current-buffer transcript
      (should (string-match-p "\\[status\\] " (buffer-string))))))

(provide 'malebolge-ert)
;;; malebolge-ert.el ends here
