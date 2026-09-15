# Forward pipeline targets so `make dry-run` works from the repo root.
.PHONY: install dry-run lint test validate examples download build verify
install dry-run lint test validate examples download build verify:
	$(MAKE) -C pipeline $@
