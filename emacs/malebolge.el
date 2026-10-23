;;; malebolge.el --- Attach to SATAN's durable session -*- lexical-binding: t; -*-

;;; Commentary:

;; A comint transcript buffer over `malebolge-attach', the line client of
;; the malebolge daemon.  The daemon owns the session; the transcript only
;; attaches, so killing it detaches and leaves the conversation running.
;;
;; Talking happens in a companion draft buffer (`*malebolge-draft*').  The
;; draft is ordinary editable text: RET inserts a newline, paste keeps every
;; line, and nothing typed there is sent until `C-c C-c' (`malebolge-submit')
;; writes the exact buffer text as one JSON frame to the attach process and
;; clears the draft.  Incoming output appears only in the transcript, and the
;; draft survives the process and reattachment.
;;
;; Draft keys (also bound in the transcript):
;;   C-c C-c  submit the draft as one input frame
;;   C-c C-a  abort the current run
;;   C-c C-m  compact the transcript (optional instructions)
;;   C-c C-q  quit, detaching from the daemon
;;   C-c C-h  show this summary
;; Transcript only: C-c C-e and RET focus the draft.  The transcript is
;; read-only for ordinary edits and never submits.  Speaker turns are
;; coloured by the turn's label line: `malebolge-user-face' and
;; `malebolge-satan-face'.  Lines beginning `[tool]' and `[status]'
;; keep their own faces (`malebolge-tool-face',
;; `malebolge-status-face').  A transcript window whose point is at the
;; end follows new output; scrolled back, it keeps its place until you
;; move to the end again (M->).
;;
;; `malebolge-start' starts satan-mcp (when loaded), the daemon's systemd
;; user unit, and attaches; `malebolge-stop' stops the unit.

;;; Code:

(require 'comint)
(require 'json)
(require 'subr-x)

(defgroup malebolge nil
  "Attach to SATAN's durable session."
  :group 'comm)

(defcustom malebolge-attach-command
  (list "node" (expand-file-name "~/dev/malebolge/src/attach-main.ts"))
  "Program and arguments that attach a line client to the daemon."
  :type '(repeat string))

(defcustom malebolge-unit "malebolge-room.service"
  "The systemd user unit that runs the daemon."
  :type 'string)

(defface malebolge-tool-face
  '((t :inherit font-lock-function-name-face))
  "Face for transcript lines that report a tool call."
  :group 'malebolge)

(defface malebolge-status-face
  '((t :inherit shadow))
  "Face for dimmer transcript lines that report session status."
  :group 'malebolge)

(defface malebolge-user-face
  '((t :inherit default))
  "Face for the user's turns in the transcript."
  :group 'malebolge)

(defface malebolge-satan-face
  '((t :inherit error :weight normal))
  "Face for SATAN's turns in the transcript."
  :group 'malebolge)

(defconst malebolge-buffer-name "*malebolge*")
(defconst malebolge-draft-buffer-name "*malebolge-draft*")

(defconst malebolge--key-summary
  "C-c C-c submit   C-c C-a abort   C-c C-m compact   C-c C-q quit   C-c C-e draft
C-c C-h help")

(defvar malebolge-transcript-mode-map (make-sparse-keymap))
(defvar malebolge-draft-mode-map (make-sparse-keymap))

(defun malebolge--init-keymaps ()
  "Populate the mode maps once, sharing the controls between both modes."
  (dolist (map (list malebolge-transcript-mode-map malebolge-draft-mode-map))
    (define-key map (kbd "C-c C-c") #'malebolge-submit)
    (define-key map (kbd "C-c C-a") #'malebolge-abort)
    (define-key map (kbd "C-c C-m") #'malebolge-compact)
    (define-key map (kbd "C-c C-q") #'malebolge-quit)
    (define-key map (kbd "C-c C-h") #'malebolge-help))
  (define-key malebolge-transcript-mode-map (kbd "C-c C-e") #'malebolge-draft)
  (define-key malebolge-transcript-mode-map (kbd "RET") #'malebolge-draft)
  ;; comint's EOF and subjob keys would close or kill the attach process.
  (dolist (key (list (kbd "C-d") (kbd "C-c C-d") (kbd "C-c C-z") (kbd "C-c C-\\")))
    (define-key malebolge-transcript-mode-map
      (vector 'remap (lookup-key comint-mode-map key))
      #'malebolge--refuse-input)))

(malebolge--init-keymaps)

(defvar malebolge--font-lock-keywords
  '(("^\\[tool\\] .*$" 0 'malebolge-tool-face t)
    ("^\\[status\\] .*$" 0 'malebolge-status-face t))
  "Font-lock keywords distinguishing tool and status lines.")

(defconst malebolge--speaker-labels
  '(("^You:$" . malebolge-user-face)
    ("^Satan\\(?: ([a-z]+)\\)?:$" . malebolge-satan-face))
  "Alist of label REGEXP to the face its turn is shown in.")

(defconst malebolge--speaker-label-regexp
  (mapconcat #'car malebolge--speaker-labels "\\|")
  "Regexp matching any speaker label line.")

(defun malebolge--label-face (line)
  "Return the face speaker label LINE opens, or nil."
  (cdr (assoc line malebolge--speaker-labels
              (lambda (regexp line) (string-match-p regexp line)))))

(defun malebolge--face-before (pos)
  "Return the speaker face in force before the line at POS, or nil."
  (save-excursion
    (goto-char (max (point-min) (1- pos)))
    (when (re-search-backward malebolge--speaker-label-regexp nil t)
      (malebolge--label-face (match-string-no-properties 0)))))

(defun malebolge--colour-speakers (start end)
  "Give START to END the speaker face each line falls under."
  (save-excursion
    (with-silent-modifications
      (goto-char start)
      (forward-line 0)
      (let ((face (malebolge--face-before (point))))
        (while (< (point) end)
          (setq face (or (malebolge--label-face
                          (buffer-substring-no-properties (point) (line-end-position)))
                         face))
          (when face
            (put-text-property (point) (line-end-position) 'font-lock-face face))
          (forward-line 1))))))

(defun malebolge--colour-output (_string)
  "Colour the speaker turn in the output chunk just inserted."
  (malebolge--colour-speakers comint-last-output-start (point-max)))

;;;###autoload
(define-derived-mode malebolge-draft-mode text-mode "Malebolge-Draft"
  "Major mode for composing one message to the malebolge daemon.
The buffer is plain text: RET inserts a newline and nothing is sent
until \\[malebolge-submit]."
  (setq-local header-line-format malebolge--key-summary)
  (electric-indent-mode -1))

;;;###autoload
(define-derived-mode malebolge-transcript-mode comint-mode "Malebolge"
  "Major mode for the read-only malebolge transcript.
Process output is inserted here; input is composed in the draft buffer."
  (setq-local header-line-format malebolge--key-summary)
  (setq-local font-lock-defaults '(malebolge--font-lock-keywords t))
  (setq-local comint-input-sender #'malebolge--refuse-input)
  ;; comint's own following suffices: a window whose point is at the
  ;; process mark follows output; one scrolled back keeps its place.
  (setq-local comint-scroll-to-bottom-on-output nil)
  (add-hook 'comint-output-filter-functions #'malebolge--colour-output nil t)
  (setq buffer-read-only t))

(declare-function satan-mcp-start "satan-mcp")

(defun malebolge--systemctl (verb)
  "Run systemctl --user VERB on `malebolge-unit'; signal on failure."
  (let ((status (call-process "systemctl" nil nil nil "--user" verb malebolge-unit)))
    (unless (eql status 0)
      (user-error "systemctl --user %s %s failed (%s); see journalctl --user -u %s"
                  verb malebolge-unit status malebolge-unit))))

(defun malebolge--live-process ()
  "Return the live attach process backing the transcript, or nil."
  (let ((process (get-buffer-process malebolge-buffer-name)))
    (and (process-live-p process) process)))

(defun malebolge--send-frame (frame)
  "Write FRAME, a plist of JSON keys and values, to the attach process.
Signal `user-error' when no live process is attached; nothing is sent."
  (let ((process (malebolge--live-process)))
    (unless process
      (user-error "malebolge: not attached to a live session; %s"
                  (if (get-buffer-process malebolge-buffer-name)
                      "the attach process has exited"
                    "run M-x malebolge-attach")))
    (process-send-string process (concat (json-serialize frame) "\n"))))

(defun malebolge--pop-to-draft ()
  "Create or reuse the draft buffer and show it below the transcript."
  (let ((draft (get-buffer-create malebolge-draft-buffer-name)))
    (with-current-buffer draft
      (unless (derived-mode-p 'malebolge-draft-mode)
        (malebolge-draft-mode)))
    (display-buffer draft
                    '((display-buffer-reuse-window display-buffer-below-selected)
                      (reusable-frames . t)))
    draft))

(defun malebolge--refuse-input (&rest _)
  "Refuse to send comint input: the transcript is for reading only.
Serves as both `comint-input-sender' and the command comint's EOF and
signal keys are remapped to."
  (interactive)
  (user-error "malebolge: the transcript does not accept input; use C-c C-e and C-c C-c"))

;;;###autoload
(defun malebolge-attach ()
  "Attach to the malebolge daemon and open its companion draft buffer."
  (interactive)
  (let ((buffer (get-buffer-create malebolge-buffer-name)))
    (with-current-buffer buffer
      (unless (derived-mode-p 'malebolge-transcript-mode)
        (malebolge-transcript-mode)))
    (unless (comint-check-proc buffer)
      ;; The transcript is derived: clear it before the new process's
      ;; snapshot can arrive, so the snapshot fills it once.
      (let ((inhibit-read-only t))
        (with-current-buffer buffer (erase-buffer)))
      (condition-case err
          (apply #'make-comint-in-buffer "malebolge" buffer
                 (car malebolge-attach-command) nil
                 (append (cdr malebolge-attach-command) '("--emacs")))
        (error
         (let ((inhibit-read-only t))
           (with-current-buffer buffer
             (insert (format "[status] cannot start %s: %s\n"
                             (car malebolge-attach-command)
                             (error-message-string err))))))))
    (pop-to-buffer buffer)
    (malebolge--pop-to-draft)))

;;;###autoload
(defun malebolge-draft ()
  "Show and focus the draft buffer, creating it when needed."
  (interactive)
  (let ((draft (malebolge--pop-to-draft)))
    (pop-to-buffer draft)
    (goto-char (point-max))))

;;;###autoload
(defun malebolge-submit ()
  "Send the whole draft as one input frame, then clear it."
  (interactive)
  (let ((draft (get-buffer malebolge-draft-buffer-name)))
    (unless draft
      (user-error "malebolge: no draft buffer; use C-c C-e to start one"))
    (with-current-buffer draft
      (let ((text (buffer-substring-no-properties (point-min) (point-max))))
        (when (string-blank-p text)
          (user-error "malebolge: the draft is empty"))
        (malebolge--send-frame (list :type "input" :content text))
        (erase-buffer)
        (message "malebolge: sent %d characters" (length text))))))

;;;###autoload
(defun malebolge-abort ()
  "Abort the daemon's current run."
  (interactive)
  (malebolge--send-frame '(:type "abort")))

;;;###autoload
(defun malebolge-compact (&optional instructions)
  "Compact the daemon transcript, optionally including INSTRUCTIONS."
  (interactive (list (read-string "Compact instructions (optional): ")))
  (malebolge--send-frame (if (string-empty-p (or instructions ""))
                             '(:type "compact")
                           (list :type "compact" :instructions instructions))))

;;;###autoload
(defun malebolge-quit ()
  "Detach this client; the daemon and the draft are untouched."
  (interactive)
  (malebolge--send-frame '(:type "quit")))

;;;###autoload
(defun malebolge-help ()
  "Show the draft workflow and its key bindings."
  (interactive)
  (with-help-window (help-buffer)
    (princ "Malebolge draft

The draft buffer holds one message.  It is plain text: RET inserts a
newline, pasting keeps every line, and nothing is sent until you submit.
Only an all-whitespace draft is refused; leading spaces, blank interior
lines, trailing spaces and leading `/` are preserved.

")
    (princ malebolge--key-summary)
    (princ "

C-c C-c submits the exact draft text as one input frame and clears the
draft.  C-c C-a aborts the current run, C-c C-m compacts the transcript
(prompting for optional instructions) and C-c C-q quits, detaching this
client.  None of them clear or alter the draft.  The transcript is
read-only; C-c C-e (or RET there) returns you to the draft.

Following

A transcript window follows process output while its point is at the end
of the buffer.  After you scroll back to read older text it keeps its
place; M-> (or any other move to the end) resumes following.

Colours

Each speaker turn is shown in its speaker's face: your turns in
`malebolge-user-face', SATAN's turns in `malebolge-satan-face' (red by
default).  A turn runs from its label line (`You:', `Satan:',
`Satan (continued):', `Satan (revised):') to the next label.  Lines beginning
`[tool]' and `[status]' keep their own faces, `malebolge-tool-face' and
`malebolge-status-face'.")))

;;;###autoload
(defun malebolge-start ()
  "Start satan-mcp if available, start the daemon unit, and attach."
  (interactive)
  (if (not (fboundp 'satan-mcp-start))
      (message "malebolge: satan-mcp not loaded; the daemon has no SATAN tools")
    (condition-case err (satan-mcp-start)
      (error (message "malebolge: satan-mcp not started (%s); the daemon has no SATAN tools"
                      (error-message-string err)))))
  (malebolge--systemctl "start")
  (malebolge-attach))

;;;###autoload
(defun malebolge-stop ()
  "Stop the daemon unit."
  (interactive)
  (malebolge--systemctl "stop"))

(provide 'malebolge)
;;; malebolge.el ends here
