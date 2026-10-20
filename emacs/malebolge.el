;;; malebolge.el --- Attach to SATAN's durable session -*- lexical-binding: t; -*-

;;; Commentary:

;; A comint buffer over `malebolge-attach', the line client of the
;; malebolge daemon.  The daemon owns the session; this buffer only
;; attaches, so killing it detaches and leaves the conversation running.
;;
;; `malebolge-start' starts satan-mcp (when loaded), the daemon's systemd
;; user unit, and attaches; `malebolge-stop' stops the unit.
;;
;; In the buffer: type to talk; /abort stops the current run; /compact
;; [instructions] compacts the transcript; /quit detaches.

;;; Code:

(require 'comint)

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

(defconst malebolge-buffer-name "*malebolge*")

(declare-function satan-mcp-start "satan-mcp")

(defun malebolge--systemctl (verb)
  "Run systemctl --user VERB on `malebolge-unit'; signal on failure."
  (let ((status (call-process "systemctl" nil nil nil "--user" verb malebolge-unit)))
    (unless (eql status 0)
      (user-error "systemctl --user %s %s failed (%s); see journalctl --user -u %s"
                  verb malebolge-unit status malebolge-unit))))

;;;###autoload
(defun malebolge-attach ()
  "Attach to the malebolge daemon in a comint buffer, reusing a live one."
  (interactive)
  (let ((buffer (get-buffer-create malebolge-buffer-name)))
    (unless (comint-check-proc buffer)
      (apply #'make-comint-in-buffer "malebolge" buffer
             (car malebolge-attach-command) nil
             (cdr malebolge-attach-command)))
    (pop-to-buffer buffer)))

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
