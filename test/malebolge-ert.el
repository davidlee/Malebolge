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
;;   C-c C-o `malebolge-orient', C-c C-q `malebolge-quit', C-c C-h `malebolge-help'.
;; - Transcript bindings: the same six controls plus C-c C-e
;;   `malebolge-draft' (show/focus the draft); `RET' focuses the draft.
;; - Frames are newline-terminated JSON written with `process-send-string':
;;   {"type":"input","content":...}, {"type":"abort"}, {"type":"compact",
;;   "instructions":...}, {"type":"orient"}, {"type":"quit"}.
;; - Faces `malebolge-tool-face' (transcript lines starting "[tool] ") and
;;   `malebolge-status-face' (lines starting "[status] ").
;; - `header-line-format' is non-nil in both buffers.
;;
;; ASSUMED API (SL-002 PHASE-03; the target picker):
;;
;; - `malebolge-attach' with a prefix argument lists the store, prompts over
;;   the ids, refuses a switch while the draft holds text, detaches, then
;;   attaches; the chosen target becomes argv before "--emacs".
;; - `malebolge--attach-arguments' turns a target (nil, "new", or an id
;;   string) into the extra argv.
;; - `malebolge--list-conversations' is the listing seam: it returns a plist
;;   (:stdout TEXT :stderr TEXT).  No ERT case starts a real client.
;; - `malebolge--conversation-candidates' parses stdout's lines: each is
;;   `id<TAB>topic<TAB>model', with an optional `<TAB>mark', offered whole.
;;   Topic and model may be empty, a mark may not, and a bare id names
;;   nothing.  `malebolge--candidate-id' names the id of such a line.
;; - `malebolge--await-exit' waits boundedly for the client to go, then
;;   deletes it.  `malebolge--detach-timeout' bounds the wait, and
;;   `malebolge--list-timeout' bounds the synchronous listing.

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

(defun malebolge-test--make-fake (&optional keep-capture)
  "Create the fake attach process, copying stdin into the capture file.
With KEEP-CAPTURE the existing capture file is reused, so a switch's
old and new processes are read from one place."
  (unless (and keep-capture malebolge-test--capture-file)
    (setq malebolge-test--capture-file
          (make-temp-file "malebolge-ert-" nil ".stdin")))
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

(ert-deftest malebolge-abort-compact-orient-quit-send-frames ()
  "Abort, compact, orient and quit write their frames and never clear the draft."
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
        (call-interactively #'malebolge-orient))
      (malebolge-test--wait)
      (let ((frame (car (last (malebolge-test--frame-values)))))
        (should (equal '((type . "orient")) frame)))
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
        (should (eq (lookup-key (current-local-map) (kbd "C-c C-o"))
                    'malebolge-orient))
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

;; Keys, not spellings: the summary's C-c C-m is the key C-c RET.
(defun malebolge-test--named-keys (text)
  "The key sequences TEXT names as \"C-c C-<letter>\"."
  (let (keys (start 0))
    (while (string-match "C-c C-[a-z]" text start)
      (push (vconcat (kbd (match-string 0 text))) keys)
      (setq start (match-end 0)))
    keys))

(ert-deftest malebolge-header-lines-and-help ()
  "Both buffers show a one-line header naming their C-c controls; help names submit."
  (malebolge-test--with-session
    (dolist (buf (list draft transcript))
      (with-current-buffer buf
        ;; `format-mode-line' answers "" under --batch: resolve the symbol here.
        (let* ((line (if (symbolp header-line-format)
                         (symbol-value header-line-format)
                       header-line-format))
               (named (malebolge-test--named-keys line)))
          ;; One line: a header line shows a newline as ^J.
          (should-not (string-match-p "\n" line))
          ;; Every malebolge control the buffer binds under C-c is named.
          (map-keymap
           (lambda (k command)
             (when (and (symbolp command)
                        (string-prefix-p "malebolge-" (symbol-name command)))
               (should (member (vector ?\C-c k) named))))
           (lookup-key (current-local-map) (kbd "C-c"))))))
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

;;; Speaker faces

(defun malebolge-test--line-face (text)
  "Return the transcript face on the first line containing TEXT.
`face' (font-lock keywords) wins over `font-lock-face', as in display; a
list of faces is reduced to its first, the one display lets win."
  (with-current-buffer malebolge-buffer-name
    (when (fboundp 'font-lock-ensure)
      (let ((font-lock-support-mode nil))
        (font-lock-ensure)))
    (save-excursion
      (goto-char (point-min))
      (search-forward text)
      (let* ((pos (line-beginning-position))
             (face (or (get-text-property pos 'face)
                       (get-text-property pos 'font-lock-face))))
        (if (consp face) (car face) face)))))

(ert-deftest malebolge-speaker-faces-follow-turns ()
  "Each turn's label and body take its speaker's face."
  (malebolge-test--with-session
    (malebolge-test--feed "You:\nhello\nsecond line\n\nSatan:\nanswer one\nanswer two\n\n")
    (should (eq 'malebolge-user-face (malebolge-test--line-face "You:")))
    (should (eq 'malebolge-user-face (malebolge-test--line-face "second line")))
    (should (eq 'malebolge-satan-face (malebolge-test--line-face "Satan:")))
    (should (eq 'malebolge-satan-face (malebolge-test--line-face "answer two")))))

(ert-deftest malebolge-speaker-faces-span-chunks ()
  "A label split across chunks still opens a turn; later chunks continue it."
  (malebolge-test--with-session
    (malebolge-test--feed "You:\nq\n\nSat")
    (malebolge-test--feed "an:\nstreamed ")
    (malebolge-test--feed "text\n")
    (malebolge-test--feed "next chunk\n")
    (should (eq 'malebolge-satan-face (malebolge-test--line-face "Satan:")))
    (should (eq 'malebolge-satan-face (malebolge-test--line-face "streamed text")))
    (should (eq 'malebolge-satan-face (malebolge-test--line-face "next chunk")))))

(ert-deftest malebolge-speaker-faces-yield-to-tool-lines ()
  "Tool lines keep their face inside a turn; a resumed turn is SATAN's."
  (malebolge-test--with-session
    (malebolge-test--feed "Satan:\nbefore\n[tool] grep {}\nSatan (continued):\nafter\n")
    (should (eq 'malebolge-tool-face (malebolge-test--line-face "[tool]")))
    (should (eq 'malebolge-satan-face (malebolge-test--line-face "Satan (continued):")))
    (should (eq 'malebolge-satan-face (malebolge-test--line-face "after")))))

(ert-deftest malebolge-thread-face-colours-post-lines-and-bodies ()
  "A post's header opens a thread turn; a reap and a wake have their own faces.
The post's body never keeps the previous speaker's colour, the reap line's
warning wins over the thread face it starts with, and a wake's body is not
coloured as SATAN's turn or the operator's."
  (malebolge-test--with-session
    (malebolge-test--feed
     (concat "Satan:\nhi\n"
             "[thread] post from 12 (research)\nbody line\n"
             "[thread] family 12/340 reaped: 5 active (cap 4)\n"
             "[wake] scheduled by 12 (seclude)\nwake intent\n"))
    (should (eq 'malebolge-thread-face
                (malebolge-test--line-face
                 "[thread] post from 12 (research)")))
    (should (eq 'malebolge-thread-face (malebolge-test--line-face "body line")))
    (should (eq 'malebolge-reap-face
                (malebolge-test--line-face
                 "[thread] family 12/340 reaped")))
    (should (eq 'malebolge-wake-face
                (malebolge-test--line-face
                 "[wake] scheduled by 12 (seclude)")))
    (should (eq 'malebolge-wake-face
                (malebolge-test--line-face "wake intent")))
    ;; A wake is input SATAN made, like a post: it reads as one by default.
    (should (eq 'malebolge-thread-face
                (face-attribute 'malebolge-wake-face :inherit)))))

(ert-deftest malebolge-reload-replaces-font-lock-keywords ()
  "Reloading malebolge.el over a stale keyword list brings in the new rules.
An upgrade is a reload into a running Emacs, so a `defvar' would keep the
old list and `[thread]' lines would stay uncoloured."
  (let ((malebolge--font-lock-keywords '(("^stale$" 0 'default t))))
    (load (locate-library "malebolge.el") nil t)
    (should (assoc "^\\[thread\\] .*$" malebolge--font-lock-keywords))))

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
  "Give window state a chance to settle.
Under `--batch' `(redisplay t)' does not recompute `window-start'; the
tests therefore assert marker positions (`window-point', `window-start')
only, which comint's output filter moves directly."
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

(ert-deftest malebolge-follow-selected-window-reading-older-text ()
  "A selected transcript window reading older text keeps its place.
Only a window whose point is at the end follows output."
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
        ;; W1 sits at the end of the transcript; W2, which we select, reads
        ;; older text.
        (set-window-point w1 (point-max))
        (with-current-buffer transcript
          (set-window-start w1 (max (point-min) (- (point-max) 4)))
          (goto-char (point-min)))
        (set-window-point w2 (point-min))
        (set-window-start w2 (point-min))
        (select-window w2)
        (malebolge-test--redisplay)
        (let ((w1-start (window-start w1))
              (w2-start (window-start w2))
              (w2-point (window-point w2)))
          (malebolge-test--feed-lines 5)
          (malebolge-test--redisplay)
          (let ((end (with-current-buffer transcript (point-max))))
            (should (= end (window-point w1)))
            (should (>= (window-point w1) w1-start))
            (should (= w2-start (window-start w2)))
            (should (= w2-point (window-point w2))))
          (should (eq w2 (selected-window))))))))

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
      (malebolge-attach))
    (should (equal "survives" (malebolge-test--draft-text)))
    (with-current-buffer transcript
      (should (string-match-p "\\[status\\] " (buffer-string))))))

;;; SL-002 PHASE-03: the target picker

(defvar malebolge-test--offered nil
  "The candidate collection the last stubbed `completing-read' received.")

(defvar malebolge-test--messages nil
  "Every message the stubbed `message' was given, newest first.")

(defmacro malebolge-test--with-target-choice (listing answer &rest body)
  "Run BODY with the listing stubbed to LISTING and the prompt answering ANSWER.
LISTING is a plist.  BODY reads the offered collection from
`malebolge-test--offered' and the messages from `malebolge-test--messages'."
  (declare (indent 2) (debug t))
  `(let ((malebolge-test--offered nil)
         (malebolge-test--messages nil))
     (cl-letf (((symbol-function 'malebolge--list-conversations)
                (lambda () ,listing))
               ((symbol-function 'completing-read)
                (lambda (_prompt collection &rest _)
                  (setq malebolge-test--offered collection)
                  ,answer))
               ((symbol-function 'message)
                (lambda (string &rest args)
                  (push (apply #'format-message string args)
                        malebolge-test--messages)))
               ((symbol-function 'redisplay) #'ignore))
       ,@body)))

(defmacro malebolge-test--with-fast-detach (&rest body)
  "Run BODY with the detach wait too short to notice, but still bounded."
  (declare (indent 0) (debug t))
  `(let ((malebolge--detach-timeout 0.2))
     ,@body))

(defun malebolge-test--started-args (thunk)
  "Run THUNK, returning the argv the attach client was started with."
  (let (started)
    (cl-letf (((symbol-function 'make-comint-in-buffer)
               (lambda (_name buffer _program _startfile &rest switches)
                 (setq started switches)
                 (with-current-buffer buffer (malebolge-test--make-fake t)))))
      (funcall thunk))
    started))

;;; The argv a target names

(ert-deftest malebolge-attach-arguments-name-each-target ()
  "Root, `new' and an id each shape the client's arguments.
The chosen target reaches the command as --conversation N, before --emacs."
  (should (equal '("--emacs") (malebolge--attach-arguments nil)))
  (should (equal '("--new" "--emacs") (malebolge--attach-arguments "new")))
  (should (equal '("--conversation" "7" "--emacs")
                 (malebolge--attach-arguments "7"))))

(ert-deftest malebolge-target-labels-read-in-a-message ()
  "A target reads as prose when it is reported."
  (should (equal "a new conversation" (malebolge--target-label "new")))
  (should (equal "conversation 7" (malebolge--target-label "7"))))

;;; Candidates come from stdout only

(ert-deftest malebolge-candidates-keep-only-the-listing-lines ()
  "Only whole id/topic/model lines are candidates; prose and bare ids never are.
Topic and model may be empty, and a marked line is offered whole (SL-010)."
  (should (equal '("9\twork\tfaux/faux-1" "0\tdefault\tfaux/faux-1" "3\t\t")
                 (malebolge--conversation-candidates
                  "9\twork\tfaux/faux-1\n0\tdefault\tfaux/faux-1\n\n3\t\t\n")))
  (should (equal '("0\tdefault\tfaux/faux-1")
                 (malebolge--conversation-candidates
                  (concat "0\tdefault\tfaux/faux-1\n"
                          "the listing was truncated: older conversations"
                          " are not shown\n"))))
  ;; A leading space, prose and a bare id are all no candidates.
  (should-not (malebolge--conversation-candidates
               " 7\tdefault\tm\nnew\n7\n")))

(ert-deftest malebolge-candidates-offer-marked-lines-whole-and-reject-malformed-ones ()
  "A marked line is a candidate offered whole; its id is what it attaches to.
An empty mark is malformed, and so is a three-field line with no id."
  (should (equal '("14\twork\t\tforked from 12" "13\tdefault\tfaux/faux-1\tfork of 12")
                 (malebolge--conversation-candidates
                  "14\twork\t\tforked from 12\n13\tdefault\tfaux/faux-1\tfork of 12\n")))
  ;; Empty topic and model, no mark: still a line the daemon printed.
  (should (equal '("7\t\t")
                 (malebolge--conversation-candidates "7\t\t\n")))
  ;; An empty mark, a non-numeric id and a prose line are all refused.
  (should-not (malebolge--conversation-candidates
               "14\tdefault\tm\t\nx\twork\tm\nnew\n"))
  (should (equal "14" (malebolge--candidate-id "14\twork\t\tforked from 12")))
  (should (equal "7" (malebolge--candidate-id "7\t\t")))
  (should-not (malebolge--candidate-id "new"))
  (should-not (malebolge--candidate-id "7"))
  (should-not (malebolge--candidate-id " 7\tdefault\tm"))
  (should-not (malebolge--candidate-id "14\tdefault\tm\t")))

;;; The listing's stderr is a message, not a candidate

(ert-deftest malebolge-prompt-offers-the-stdout-ids-and-messages-stderr ()
  "The truncation prose is a message; the candidates are stdout's ids plus new."
  (malebolge-test--with-session
    (malebolge-test--with-target-choice
        '(:stdout "9\twork\tfaux/faux-1\n7\tdefault\tfaux/faux-1\n"
          :stderr "the listing was truncated: older conversations are not shown\n")
        "7\tdefault\tfaux/faux-1"
      (malebolge-test--with-fast-detach
        (malebolge-test--started-args (lambda () (malebolge-attach '(4)))))
      (should (equal '("9\twork\tfaux/faux-1" "7\tdefault\tfaux/faux-1" "new")
                     malebolge-test--offered))
      (should (cl-some (lambda (message) (string-match-p "truncated" message))
                       malebolge-test--messages)))))

;;; The fixed order: list, prompt, draft check, detach, attach

(ert-deftest malebolge-prefix-argument-refuses-a-draft-bearing-switch-before-detaching ()
  "A non-empty draft refuses a draft-bearing switch before detaching.
The client stays attached and the draft survives untouched."
  (malebolge-test--with-session
    (malebolge-test--with-target-choice
        '(:stdout "9\twork\tfaux/faux-1\n7\tdefault\tfaux/faux-1\n" :stderr "")
        "7\tdefault\tfaux/faux-1"
      (malebolge-test--insert-draft "unsent words")
      (malebolge-test--with-fast-detach
        (should-error (malebolge-attach '(4)) :type 'user-error))
      (malebolge-test--wait)
      (should-not (malebolge-test--frames))
      (should (process-live-p (get-buffer-process transcript)))
      (should (equal "unsent words" (malebolge-test--draft-text))))))

(ert-deftest malebolge-switch-detaches-then-attaches-with-the-chosen-target-as-argv ()
  "The switch sends the quit frame, then starts the client with --conversation N."
  (malebolge-test--with-session
    (malebolge-test--with-target-choice
        '(:stdout "9\twork\tfaux/faux-1\n7\tdefault\tfaux/faux-1\n" :stderr "")
        "7\tdefault\tfaux/faux-1"
      (let (quit-before-attach started)
        (malebolge-test--with-fast-detach
          (cl-letf (((symbol-function 'make-comint-in-buffer)
                     (lambda (_name buffer _program _startfile &rest switches)
                       (setq quit-before-attach (malebolge-test--capture-bytes)
                             started switches)
                       (with-current-buffer buffer (malebolge-test--make-fake t)))))
            (malebolge-attach '(4))))
        (should (equal '("--conversation" "7" "--emacs") started))
        (should (string-match-p "\"quit\"" (or quit-before-attach "")))))))

(ert-deftest malebolge-picker-attaches-to-a-marked-id ()
  "The picker attaches to a marked id: a marked line is offered whole and
the client starts with the bare id it names."
  (malebolge-test--with-session
    (malebolge-test--with-target-choice
        (list :stdout
              (concat "14\twork\t\tforked from 12\n"
                      "13\tdefault\tfaux/faux-1\tfork of 12\n"
                      "12\twork\tfaux/faux-1\n")
              :stderr "")
        "14\twork\t\tforked from 12"
      (let ((started (malebolge-test--with-fast-detach
                       (malebolge-test--started-args
                        (lambda () (malebolge-attach '(4)))))))
        (should (equal '("14\twork\t\tforked from 12"
                         "13\tdefault\tfaux/faux-1\tfork of 12"
                         "12\twork\tfaux/faux-1"
                         "new")
                       malebolge-test--offered))
        (should (equal '("--conversation" "14" "--emacs") started))))))

(ert-deftest malebolge-switch-leaves-the-transcript-empty-when-the-second-attach-fails ()
  "A failed second attach reports and leaves the transcript empty, never root."
  (malebolge-test--with-session
    (malebolge-test--with-target-choice
        '(:stdout "9\twork\tfaux/faux-1\n7\tdefault\tfaux/faux-1\n" :stderr "")
        "7\tdefault\tfaux/faux-1"
      (malebolge-test--feed "old conversation\n")
      (malebolge-test--with-fast-detach
        (cl-letf (((symbol-function 'make-comint-in-buffer)
                   (lambda (&rest _)
                     (signal 'error '("no conversation 7")))))
          (let ((failure (should-error (malebolge-attach '(4)) :type 'user-error)))
            (should (string-match-p "no conversation 7"
                                    (error-message-string failure))))))
      (should (equal "" (with-current-buffer transcript (buffer-string))))
      (should-not (process-live-p (get-buffer-process transcript))))))

(ert-deftest malebolge-prefix-argument-aborts-the-attach-when-the-listing-fails ()
  "A `--list' that exits non-zero aborts the attach when the listing fails.
The client's own message is signalled, nothing is detached, and nothing is
attached."
  (malebolge-test--with-session
    (let ((prompted nil))
      (malebolge-test--with-fast-detach
        (cl-letf (((symbol-function 'malebolge--list-conversations)
                   (lambda ()
                     (signal 'user-error
                             '("malebolge: cannot list conversations: \
the daemon predates list"))))
                  ((symbol-function 'completing-read)
                   (lambda (&rest _) (setq prompted t) "7"))
                  ((symbol-function 'message) #'ignore)
                  ((symbol-function 'redisplay) #'ignore))
          (let ((failure (should-error (malebolge-attach '(4)) :type 'user-error)))
            (should (string-match-p "predates list"
                                    (error-message-string failure))))))
      (malebolge-test--wait)
      (should-not prompted)
      (should-not (malebolge-test--frames))
      (should (process-live-p (get-buffer-process transcript))))))

(ert-deftest malebolge-attach-without-a-prefix-argument-attaches-to-root-and-never-lists ()
  "No prefix argument: no listing, no prompt, argv is --emacs alone."
  (malebolge-test--with-session
    (delete-process (get-buffer-process transcript))
    (cl-letf (((symbol-function 'malebolge--list-conversations)
               (lambda () (error "the plain path must not list")))
              ((symbol-function 'completing-read)
               (lambda (&rest _) (error "the plain path must not prompt"))))
      (should (equal '("--emacs")
                     (malebolge-test--started-args (lambda () (malebolge-attach))))))))

;;; Following survives the switch

(ert-deftest malebolge-switch-puts-every-transcript-window-at-point-max ()
  "Both transcript windows, including one scrolled back, end at point-max and follow.
Clearing the transcript clamps every window's point, and comint follows only a
window whose point is at the process mark, so the switch sets each window point."
  (malebolge-test--with-session
    (malebolge-test--with-transcript-frame
      (malebolge-test--feed-lines 200)
      (malebolge-test--redisplay)
      (delete-other-windows)
      (set-window-buffer (selected-window) draft)
      (let* ((draft-window (selected-window))
             (w1 (split-window-below))
             (w2 (split-window-below)))
        (set-window-buffer w1 transcript)
        (set-window-buffer w2 transcript)
        ;; W1 sits at the end; W2 reads older text.  Neither is selected.
        (with-current-buffer transcript
          (set-window-point w1 (point-max))
          (set-window-start w1 (max (point-min) (- (point-max) 4)))
          (set-window-point w2 (point-min))
          (set-window-start w2 (point-min)))
        (select-window draft-window)
        (malebolge-test--redisplay)
        (malebolge-test--with-target-choice
            '(:stdout "9\tdefault\tfaux/faux-1\n" :stderr "")
            "9\tdefault\tfaux/faux-1"
          (malebolge-test--with-fast-detach
            (malebolge-test--started-args (lambda () (malebolge-attach '(4)))))
          (malebolge-test--feed-lines 200)
          (malebolge-test--redisplay)
          (let ((end (with-current-buffer transcript (point-max))))
            (should (= end (window-point w1)))
            (should (= end (window-point w2)))
            (should (> (window-start w2) (point-min)))))))))

(ert-deftest malebolge-follow-puts-a-scrolled-back-window-at-point-max ()
  "`malebolge--follow' itself moves a window that was reading older text.
A switch happens to satisfy this through the erase, which clamps every
window to the process mark; the helper makes it independent of that."
  (malebolge-test--with-session
    (malebolge-test--feed-lines 200)
    (malebolge-test--with-transcript-frame
      (delete-other-windows)
      (set-window-buffer (selected-window) draft)
      (let ((draft-window (selected-window))
            (window (split-window-below)))
        (set-window-buffer window transcript)
        (with-current-buffer transcript
          (set-window-point window (point-min))
          (set-window-start window (point-min)))
        (select-window draft-window)
        (malebolge-test--redisplay)
        (malebolge--follow (get-buffer malebolge-buffer-name))
        (should (= (with-current-buffer transcript (point-max))
                   (window-point window)))))))

;;; The bounded wait

(ert-deftest malebolge-await-exit-deletes-a-client-that-will-not-go ()
  "The switch's wait is bounded: a client that ignores the quit is deleted."
  (malebolge-test--with-session
    (let ((malebolge--detach-timeout 0.1)
          (process (get-buffer-process transcript))
          (started (float-time)))
      (malebolge--await-exit process)
      (should-not (process-live-p process))
      (should (< (- (float-time) started) 2)))))

;;; The listing itself, without a daemon

(ert-deftest malebolge-listing-keeps-stdout-and-stderr-apart ()
  "The listing's lines and its prose arrive in separate streams, never merged."
  (let ((malebolge-attach-command
         '("sh" "-c"
           "printf '9\\twork\\tfaux/faux-1\\n7\\tdefault\\t\\n'; printf 'cut short\\n' >&2")))
    (let ((listing (malebolge--list-conversations)))
      (should (equal "9\twork\tfaux/faux-1\n7\tdefault\t\n"
                     (plist-get listing :stdout)))
      (should (equal "cut short\n" (plist-get listing :stderr))))))

(ert-deftest malebolge-listing-gives-up-when-the-daemon-never-answers ()
  "The listing is bounded, so a daemon that never replies cannot freeze Emacs."
  ;; `sh -c' ignores the "extra argument --list", so this process really does hang.
  (let ((malebolge-attach-command '("sh" "-c" "sleep 30"))
        (malebolge--list-timeout 0.2)
        (started (float-time)))
    (should-error (malebolge--list-conversations) :type 'user-error)
    (should (< (- (float-time) started) 5))))

(provide 'malebolge-ert)
;;; malebolge-ert.el ends here
