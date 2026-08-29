# Pocketknife runtime — single generic, schema-driven backend engine.
#
# Go is expected on PATH. If you installed it under ~/.local/go (no Homebrew),
# run: export PATH="$$HOME/.local/go/bin:$$PATH"

GO ?= go
ADDR ?= 127.0.0.1:8080
CATALOG ?= catalog
DATA ?= data

ENGINE_DIR ?= engine

.PHONY: all build run test vet fmt clean tidy

all: build

build:
	cd $(ENGINE_DIR) && $(GO) build -o ../bin/pocketknife ./cmd/pocketknife

run:
	cd $(ENGINE_DIR) && $(GO) run ./cmd/pocketknife -addr $(ADDR) -catalog ../$(CATALOG) -data ../$(DATA)

test:
	cd $(ENGINE_DIR) && $(GO) test ./...

vet:
	cd $(ENGINE_DIR) && $(GO) vet ./...

fmt:
	cd $(ENGINE_DIR) && $(GO) fmt ./...

tidy:
	cd $(ENGINE_DIR) && $(GO) mod tidy

clean:
	rm -rf bin
	find $(DATA) -name 'data.db*' -delete
