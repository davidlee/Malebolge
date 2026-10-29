# Don't mirror an upstream filter's view; have the upstream report what it saw

When a safety invariant is 'consumer view ⊆ what the upstream checker saw', make the upstream report its view (e.g. seen extents) instead of re-implementing its cuts; mirrors break on every upstream change (SL-007 RV-020).
