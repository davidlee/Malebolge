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
;;   C-c C-o  orient: re-send SATAN's fresh boot context as an input
;;   C-c C-q  quit, detaching from the daemon
;;   C-c C-h  show this summary
;; Transcript only: C-c C-e and RET focus the draft.  The transcript is
;; read-only for ordinary edits and never submits.  Speaker turns are
;; coloured by the turn's label line: `malebolge-user-face' and
;; `malebolge-satan-face'.  A post's header (`[thread] post from 12')
;; opens a turn in `malebolge-thread-face' and a wake's
;; (`[wake] scheduled by 12') in `malebolge-user-face', so no body keeps
;; the previous speaker's colour.  Lines beginning `[tool]' and
;; `[status]' keep their own faces (`malebolge-tool-face',
;; `malebolge-status-face'); so do `[thread]' lines
;; (`malebolge-thread-face') and a reaped family's
;; (`malebolge-reap-face').  A transcript window whose point is at the
;; end follows new output; scrolled back, it keeps its place until you
;; move to the end again (M->).
;;
;; `malebolge-start' starts satan-mcp (when loaded), the daemon's systemd
;; user unit, and attaches; `malebolge-stop' stops the unit.
;;
;; `M-x malebolge-attach' with a prefix argument asks the daemon which
;; conversations it holds, prompts for one, and switches to it.  The switch
;; is refused while the draft holds unsent text: the draft is shared, so it
;; would otherwise post one conversation's words to another.

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

(defface malebolge-thread-face
  '((t :inherit font-lock-constant-face))
  "Face for transcript lines reporting another conversation's thread."
  :group 'malebolge)

(defface malebolge-reap-face
  '((t :inherit warning))
  "Face for transcript lines reporting a reaped family."
  :group 'malebolge)

(defconst malebolge-buffer-name "*malebolge*")
(defconst malebolge-draft-buffer-name "*malebolge-draft*")

(defconst malebolge--key-summary
  (concat "C-c C-c submit  C-c C-a abort  C-c C-m compact  C-c C-o orient  "
          "C-c C-q quit  C-c C-e draft  C-c C-h help")
  "The controls, on one line: a header line shows a newline as ^J.")

(defvar malebolge-transcript-mode-map (make-sparse-keymap))
(defvar malebolge-draft-mode-map (make-sparse-keymap))

(defun malebolge--init-keymaps ()
  "Populate the mode maps once, sharing the controls between both modes."
  (dolist (map (list malebolge-transcript-mode-map malebolge-draft-mode-map))
    (define-key map (kbd "C-c C-c") #'malebolge-submit)
    (define-key map (kbd "C-c C-a") #'malebolge-abort)
    (define-key map (kbd "C-c C-m") #'malebolge-compact)
    (define-key map (kbd "C-c C-o") #'malebolge-orient)
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

(defconst malebolge--font-lock-keywords
  '(("^\\[tool\\] .*$" 0 'malebolge-tool-face t)
    ("^\\[status\\] .*$" 0 'malebolge-status-face t)
    ("^\\[thread\\] .*$" 0 'malebolge-thread-face t)
    ;; Last, so a reap's warning wins over the thread face it starts with.
    ("^\\[thread\\] family .* reaped.*$" 0 'malebolge-reap-face t))
  "Font-lock keywords for tool, status, thread and reap lines.")

(defconst malebolge--speaker-labels
  '(("^You:$" . malebolge-user-face)
    ("^Satan\\(?: ([a-z]+)\\)?:$" . malebolge-satan-face)
    ("^\\[thread\\] post from .*$" . malebolge-thread-face)
    ("^\\[wake\\] scheduled by .*$" . malebolge-user-face))
  "Alist of label REGEXP to the face its turn is shown in.
Each REGEXP matches a whole line: a label is looked up per line.")

(defconst malebolge--speaker-label-regexp
  (mapconcat #'car malebolge--speaker-labels "\\|")
  "Regexp matching any speaker label line.")

(defun malebolge--label-face (line)
  "Return the face speaker label LINE opens, or nil.
Each label REGEXP is matched against LINE as a whole."
  (let (face)
    (dolist (label malebolge--speaker-labels face)
      (when (and (not face) (string-match-p (car label) line))
        (setq face (cdr label))))))

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
  (setq-local header-line-format 'malebolge--key-summary)
  (electric-indent-mode -1))

;;;###autoload
(define-derived-mode malebolge-transcript-mode comint-mode "Malebolge"
  "Major mode for the read-only malebolge transcript.
Process output is inserted here; input is composed in the draft buffer."
  (setq-local header-line-format 'malebolge--key-summary)
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

;;; Choosing the conversation to attach to

(defvar malebolge--detach-timeout 2.0
  "Seconds to wait for a detached client to exit before deleting it.")

(defvar malebolge--list-timeout 5.0
  "Seconds to wait for the listing client to answer before giving up.")

(defun malebolge--attach-arguments (target)
  "Extra arguments for the attach client when it should open TARGET.
TARGET is nil for root, `new', or a conversation id."
  (cond ((null target) '("--emacs"))
        ((equal target "new") '("--new" "--emacs"))
        (t (list "--conversation" target "--emacs"))))

(defun malebolge--target-label (target)
  "How TARGET reads inside a message."
  (if (equal target "new")
      "a new conversation"
    (format "conversation %s" target)))

(defun malebolge--list-conversations ()
  "Ask the daemon which conversations this store holds.
Run the attach client with `--list' and wait, boundedly, for it: its
standard output in a temporary buffer and its standard error in a buffer
of its own.  Return a plist (:stdout TEXT :stderr TEXT); signal
`user-error', naming the client's output, when it fails or never answers."
  (with-temp-buffer
    (let* ((stderr (generate-new-buffer " *malebolge-list-stderr*"))
           (pipe (make-pipe-process :name "malebolge-list-stderr"
                                    :buffer stderr
                                    :sentinel #'ignore
                                    :noquery t)))
      (unwind-protect
          (let ((process (make-process
                          :name "malebolge-list"
                          :buffer (current-buffer)
                          :stderr pipe
                          :sentinel #'ignore
                          :connection-type 'pipe
                          :noquery t
                          :command (append malebolge-attach-command
                                           '("--list")))))
            (malebolge--await-listing process)
            (let ((out (buffer-string))
                  (err (with-current-buffer stderr (buffer-string)))
                  (status (process-exit-status process)))
              (unless (eql status 0)
                (user-error "malebolge: cannot list conversations: %s"
                            (string-trim (concat out err))))
              (list :stdout out :stderr err)))
        (when (process-live-p pipe)
          (delete-process pipe))
        (when (buffer-live-p stderr)
          (kill-buffer stderr))))))

(defun malebolge--await-listing (process)
  "Wait, boundedly, for the listing PROCESS to exit, and signal if it will not.
The client answers and closes; one still running after
`malebolge--list-timeout' is waiting for a daemon that never will."
  (let ((deadline (+ (float-time) malebolge--list-timeout)))
    (while (and (process-live-p process) (< (float-time) deadline))
      (accept-process-output process 0.05)))
  (when (process-live-p process)
    (delete-process process)
    (user-error
     "malebolge: the daemon did not answer the listing in %s seconds"
     malebolge--list-timeout)))

(defun malebolge--candidate-id (candidate)
  "The conversation id the candidate line CANDIDATE names, or nil.
A line is either a bare id (`12') or an id, a tab and a non-empty mark
(`14\tstarted by 12'); prose names nothing."
  (when (and (stringp candidate)
             (string-match "\\`\\([0-9]+\\)\\(?:\t[^\t]+\\)?\\'" candidate))
    (match-string 1 candidate)))

(defun malebolge--conversation-candidates (stdout)
  "The conversation lines in STDOUT, one per line, in the daemon's order.
A marked line (`id\tmark') is offered whole, so the prompt can show the
mark; prose is not a candidate, nor is an id whose mark is empty."
  (let (candidates)
    (dolist (line (split-string stdout "\n" t))
      (when (malebolge--candidate-id line)
        (push line candidates)))
    (nreverse candidates)))

(defun malebolge--choose-target ()
  "Ask which conversation to attach to.
The daemon's own lines come first, newest first, then `new'.  A listing
the daemon cut short says so as a message, never as a candidate."
  (message "malebolge: asking the daemon which conversations it holds...")
  (redisplay)
  (let* ((listing (malebolge--list-conversations))
         (candidates (malebolge--conversation-candidates
                      (or (plist-get listing :stdout) "")))
         (diagnostics (string-trim (or (plist-get listing :stderr) ""))))
    ;; Said after the prompt: a message sent before it would be replaced by
    ;; the minibuffer's own prompt before anyone could read it.
    (prog1 (let ((choice (completing-read "Conversation (new to create): "
                                          (append candidates (list "new"))
                                          nil t)))
             ;; A candidate is the whole listing line; the target is its id.
             (or (malebolge--candidate-id choice) choice))
      (unless (string-empty-p diagnostics)
        (message "malebolge: %s" diagnostics)))))

(defun malebolge--refuse-pending-draft ()
  "Refuse a conversation switch while the draft holds unsent text."
  (let ((draft (get-buffer malebolge-draft-buffer-name)))
    (when (and draft
               (with-current-buffer draft
                 (not (string-blank-p (buffer-substring-no-properties
                                       (point-min) (point-max))))))
      (user-error "malebolge: the draft holds unsent text; \
submit it (C-c C-c) or clear it before switching"))))

(defun malebolge--await-exit (process)
  "Wait for PROCESS to exit, boundedly, then delete it if it survives.
The client leaves on the `quit' frame; one that does not is not going to."
  (let ((deadline (+ (float-time) malebolge--detach-timeout)))
    (while (and (process-live-p process) (< (float-time) deadline))
      (accept-process-output process 0.05)))
  (when (process-live-p process)
    (delete-process process)))

(defun malebolge--detach-waiting ()
  "Detach the live client and wait, boundedly, for it to exit."
  (when (malebolge--live-process)
    (malebolge-quit)
    (malebolge--await-exit (get-buffer-process malebolge-buffer-name))))

(defun malebolge--follow (buffer)
  "Put BUFFER's point, and every window showing it, at its end.
Comint follows only a window whose point is at the process mark.  A
switch's erase clamps every window there as well, so this is a
guarantee rather than the mechanism -- one that survives a switch
which does not erase (DEC-009)."
  (with-current-buffer buffer
    (goto-char (point-max))
    (dolist (window (get-buffer-window-list buffer nil t))
      (set-window-point window (point-max)))))

(defun malebolge--start-transcript (target)
  "Start the attach client in the transcript buffer, attached to TARGET.
TARGET is nil for root, `new', or a conversation id.  A client that will
not start is reported for root as a `[status]' line, as it always has
been; for a chosen TARGET it signals `user-error' instead, leaving the
transcript empty rather than silently attaching somewhere else."
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
                 (append (cdr malebolge-attach-command)
                         (malebolge--attach-arguments target)))
        (error
         (if target
             (user-error "malebolge: cannot attach to %s: %s"
                         (malebolge--target-label target)
                         (error-message-string err))
           (let ((inhibit-read-only t))
             (with-current-buffer buffer
               (insert (format "[status] cannot start %s: %s\n"
                               (car malebolge-attach-command)
                               (error-message-string err)))))))))
    buffer))

;;;###autoload
(defun malebolge-attach (&optional choose)
  "Attach to the malebolge daemon and open its companion draft buffer.
With a prefix argument, ask the daemon which conversations it holds and
prompt for the one to open: list, prompt, draft check, detach, attach, so
nothing is torn down before the decisions that could refuse it.
Without one, attach to root as always."
  (interactive "P")
  (let ((target (and choose (malebolge--choose-target))))
    (when target
      (malebolge--refuse-pending-draft)
      (malebolge--detach-waiting))
    (let ((buffer (malebolge--start-transcript target)))
      (pop-to-buffer buffer)
      (when target
        (malebolge--follow buffer))
      (malebolge--pop-to-draft))))

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
(defun malebolge-orient ()
  "Ask the daemon to re-send SATAN's fresh boot context as an input.
Use it once compaction has folded the conversation's first one away."
  (interactive)
  (malebolge--send-frame '(:type "orient")))

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
(prompting for optional instructions), C-c C-o re-sends SATAN's fresh boot
context (percept, attention, motive) as an input, and C-c C-q quits,
detaching this client.  None of them clear or alter the draft.  The transcript is
read-only; C-c C-e (or RET there) returns you to the draft.

Following

A transcript window follows process output while its point is at the end
of the buffer.  After you scroll back to read older text it keeps its
place; M-> (or any other move to the end) resumes following.

Colours

Each speaker turn is shown in its speaker's face: your turns in
`malebolge-user-face', SATAN's turns in `malebolge-satan-face' (red by
default).  A turn runs from its label line (`You:', `Satan:',
`Satan (continued):', `Satan (revised):') to the next label.  A post from
another thread (`[thread] post from 12 (research)') opens a turn of its
own in `malebolge-thread-face', and a wake (`[wake] scheduled by 12') in
`malebolge-user-face', so neither colours its body as the previous
speaker's.  Lines beginning `[tool]' and `[status]' keep their own faces,
`malebolge-tool-face' and `malebolge-status-face'.  So do `[thread]'
lines, which take `malebolge-thread-face', except a reaped family's
(`[thread] family 12/340 reaped: ...'), which takes `malebolge-reap-face'.")))

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
