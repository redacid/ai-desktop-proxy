# Build and run targets for the Electron app. `make` alone lists them.
NPM      ?= npm
NODE_BIN := node_modules/.bin
STAMP    := node_modules/.install-stamp
# Written by electron's postinstall once its binary is downloaded.
ELECTRON := node_modules/electron/path.txt

.DEFAULT_GOAL := help
.PHONY: bump version test-release icons help install dev build run run-hidden typecheck test test-addon test-legacy lint check dist dist-appimage dist-deb clean distclean

help: ## Show this list
	@grep -hE '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*## "}{printf "  \033[36m%-14s\033[0m %s\n",$$1,$$2}'

$(STAMP): package.json $(wildcard package-lock.json)
	$(NPM) $(if $(wildcard package-lock.json),ci,install)
	@touch $@

# npm skips electron's postinstall when ignore-scripts is set, leaving no binary
# ("Error: Electron uninstall"). Download it explicitly in that case.
$(ELECTRON): $(STAMP)
	node node_modules/electron/install.js

install: $(STAMP) $(ELECTRON) ## Install npm dependencies (npm ci when package-lock.json exists)

dev: $(STAMP) $(ELECTRON) ## Run in dev mode with hot reload
	$(NPM) run dev

build: $(STAMP) ## Build main, preload and renderer into out/
	$(NPM) run build

run: build $(ELECTRON) ## Build, then start the built app
	$(NODE_BIN)/electron-vite preview

run-hidden: build $(ELECTRON) ## Build, then start straight into the tray
	$(NODE_BIN)/electron-vite preview -- --hidden

typecheck: $(STAMP) ## Type-check main, preload and renderer
	$(NPM) run typecheck

test: $(STAMP) ## Run unit tests (vitest)
	$(NPM) test

test-addon: ## Run the mitmproxy addon tests (python3, no mitmproxy needed)
	python3 resources/mitmproxy/test_cdp_addon.py

test-legacy: ## Run the old settings_env.py test
	cd legacy && python3 test_settings_env.py

lint: typecheck ## Alias for typecheck until a linter is added

check: typecheck test test-addon test-release ## Everything CI should run

dist: build $(ELECTRON) ## Package AppImage and deb into dist/
	$(NODE_BIN)/electron-builder --linux

dist-appimage: build $(ELECTRON) ## Package only the AppImage
	$(NODE_BIN)/electron-builder --linux AppImage

dist-deb: build $(ELECTRON) ## Package only the deb
	$(NODE_BIN)/electron-builder --linux deb

icons: ## Regenerate app and tray icons from scripts/icons.mjs (needs Playwright's Chromium)
	node scripts/icons.mjs

clean: ## Remove build output (out/, dist/)
	rm -rf out dist

distclean: clean ## Also remove node_modules
	rm -rf node_modules

# VERSION=1.2.3 for an explicit version; otherwise BUMP=patch|minor|major (default patch).
bump: ## Update the app version in package.json and package-lock.json
	VERSION="$(VERSION)" BUMP="$(or $(BUMP),patch)" python3 scripts/version.py bump

version: ## Bump the version and prepend commits since the previous version to CHANGELOG.md
	VERSION="$(VERSION)" BUMP="$(or $(BUMP),patch)" python3 scripts/version.py version

test-release: ## Test version bumps and changelog generation in temporary Git repositories
	python3 scripts/test_version.py
