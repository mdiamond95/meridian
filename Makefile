# Forward pipeline targets so `make dry-run` works from the repo root.
.PHONY: install dry-run lint test
install dry-run lint test:
	$(MAKE) -C pipeline $@
