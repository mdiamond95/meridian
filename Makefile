# Forward pipeline targets so `make dry-run` works from the repo root.
.PHONY: install dry-run lint test validate examples download build verify atlas
install dry-run lint test validate examples download build verify atlas:
	$(MAKE) -C pipeline $@
