;;; pandaemonium.el --- Attach to SATAN's durable session -*- lexical-binding: t; -*-

;;; Commentary:

;; A comint buffer over `pandaemonium-attach', the line client of the
;; pandaemonium daemon.  The daemon owns the session; this buffer only
;; attaches, so killing it detaches and leaves the conversation running.
;;
;; In the buffer: type to talk; /abort stops the current run; /compact
;; [instructions] compacts the transcript; /quit detaches.

;;; Code:

(require 'comint)

(defgroup pandaemonium nil
  "Attach to SATAN's durable session."
  :group 'comm)

(defcustom pandaemonium-attach-command
  (list "node" (expand-file-name "~/dev/pandaemonium/src/attach-main.ts"))
  "Program and arguments that attach a line client to the daemon."
  :type '(repeat string))

(defconst pandaemonium-buffer-name "*pandaemonium*")

;;;###autoload
(defun pandaemonium-attach ()
  "Attach to the pandaemonium daemon in a comint buffer, reusing a live one."
  (interactive)
  (let ((buffer (get-buffer-create pandaemonium-buffer-name)))
    (unless (comint-check-proc buffer)
      (apply #'make-comint-in-buffer "pandaemonium" buffer
             (car pandaemonium-attach-command) nil
             (cdr pandaemonium-attach-command)))
    (pop-to-buffer buffer)))

(provide 'pandaemonium)
;;; pandaemonium.el ends here
