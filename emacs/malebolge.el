;;; malebolge.el --- Attach to SATAN's durable session -*- lexical-binding: t; -*-

;;; Commentary:

;; A comint buffer over `malebolge-attach', the line client of the
;; malebolge daemon.  The daemon owns the session; this buffer only
;; attaches, so killing it detaches and leaves the conversation running.
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

(defconst malebolge-buffer-name "*malebolge*")

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

(provide 'malebolge)
;;; malebolge.el ends here
