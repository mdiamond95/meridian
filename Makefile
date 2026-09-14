# Forward pipeline targets so `make dry-run` works from the repo root.
.PHONY: install dry-run lint test validate examples
install dry-run lint test validate examples:
	$(MAKE) -C pipeline $@
