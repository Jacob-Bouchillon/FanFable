# Requirements

Everything FanFable needs, split into what runs the program, what it talks to,
and what is only needed to develop on it. The project was developed on Ubuntu
and is also supported on Windows 11; the platform differences are called out
where they matter.

## 1. Runtime

| Requirement | Version | Why |
| --- | --- | --- |
| Node.js | **22.18.0 or newer** | The program is TypeScript executed directly by Node. Type stripping is on by default from 22.18, and `node:sqlite` is available without a flag from 22.13. Both are used everywhere. |
| npm | 10 or newer (bundled with Node) | `npm ci` installs the two development dependencies. |
| Git | any recent version | Only needed to clone the repo. `dev-summary` shells out to `git rev-parse` for a build label. |
| Poppler (`pdftotext`, `pdfinfo`) | 22.x or newer | Only for importing **PDF** sources. EPUB and DOCX are read in-process. |

There is **no runtime npm dependency**: `package.json` ships zero `dependencies`
and three packages of `devDependencies` (TypeScript plus `@types/node`). There is
no Python, no C/C++ toolchain, no node-gyp, and no database server — SQLite is
the one built into Node (`node:sqlite`) and lives in a single `.db` file.

Poppler is optional if you convert first:

```bash
pdftotext -layout book.pdf book.txt
```

Then import the `.txt`. Scanned PDFs need OCR before either route works.

## 2. A model server

FanFable does no inference itself. It talks to one local chat model through one
of three providers, all configured with the same address/model pair:

| Provider | Endpoint it calls | Typical server |
| --- | --- | --- |
| `ollama` (default) | `POST {baseUrl}/api/chat`, `GET /api/tags` | Ollama on `http://127.0.0.1:11434` |
| `llamacpp` | `POST {baseUrl}/v1/chat/completions` | `llama-server` (OpenAI-shaped) |
| `openai` | `POST {baseUrl}/v1/chat/completions` | Any OpenAI-compatible gateway |

Defaults: `http://127.0.0.1:11434`, chat model `llama3.1:8b`, `temperature 0.8`,
`maxTokens 2048`, `contextTokens 16384`.

Embeddings are separate. `lore embed` and dense retrieval call an Ollama-style
`/api/embed` with `nomic-embed-text` by default. If the chat model is a remote
gateway, set `embeddingBaseUrl` (or `--embedding-base-url`) so embeddings stay
local.

```bash
ollama pull llama3.1:8b
ollama pull nomic-embed-text
```

Remote providers are opt-in: a non-loopback `baseUrl` plus `--api-key`. The key
is written to the config file, never sent to a loopback endpoint, and redacted
from errors.

### Hardware

Sizes are approximate and depend on quantization:

- `llama3.1:8b` — ~4.7 GB on disk, needs roughly 8 GB of VRAM, or 8–10 GB of
  system RAM when running on CPU.
- `nomic-embed-text` — ~275 MB.
- A smaller 7B/8B model at Q4 is the comfortable minimum. Extraction over a full
  book makes hundreds of calls, so CPU-only works but is slow.
- Budget ~10 GB of free disk for models, plus the project databases. A long book
  with embeddings can add a few hundred MB per project.

## 3. Where data lives

| What | Default | Override |
| --- | --- | --- |
| Project database | `~/.local/share/fanfable/fanfable.db` | `FANFABLE_DATA_DIR`, `FANFABLE_DB` |
| Model settings (incl. API key) | `~/.config/fanfable/config.json` | `FANFABLE_CONFIG_DIR` |
| Imported source files | `<repo>/.imports/` | — |

On Windows these resolve under `C:\Users\<you>\`, e.g.
`C:\Users\<you>\.local\share\fanfable\fanfable.db`. They are not redirected to
`%APPDATA%`; set `FANFABLE_DATA_DIR` if you want them somewhere else.

On POSIX the config file is written mode `0600` and its directory `0700`. Windows
has no equivalent bit, so `chmod` does not restrict the file there; the profile
directory's own ACLs are what protect it. Do not move `config.json` into a shared
folder.

Other environment switches: `FANFABLE_API_KEY` (overrides the stored key),
`OPENROUTER_API_KEY` (read as a fallback), `FANFABLE_DEV=1` (enables `/dev-viz`),
`FANFABLE_NO_GUARD=1`, `FANFABLE_REL_STRICT`, `FANFABLE_REL_LIBERAL`,
`FANFABLE_REL_FEWSHOT`, `FANFABLE_REL_ROSTER` (extraction experiments).

The web UI listens on `127.0.0.1:8123` only. It is not reachable from another
machine, and there is no authentication because there is no network surface.
`serve --port <n>` changes the port.

## 4. Windows 11

Install the runtime:

```powershell
winget install OpenJS.NodeJS.LTS
winget install oschwartz10612.Poppler
```

Two things bite on a fresh Windows box:

1. **PowerShell blocks `npm.ps1`.** The default execution policy is `Restricted`,
   so `npm` fails with "running scripts is disabled on this system". Either call
   `npm.cmd` explicitly, or allow local scripts once:

   ```powershell
   Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
   ```

   Open a new terminal afterwards so `node` and `npm` are on `PATH`.

2. **Poppler arrives without a shell refresh.** The winget package is a zip
   extracted under `%LOCALAPPDATA%\Microsoft\WinGet\Packages\`, and winget adds
   its `bin` folder to your user `PATH`. A terminal that was already open will
   not see it: open a new one and confirm `pdftotext -v`. If that still fails,
   add the folder to `PATH` by hand. Without it, PDF import fails with an
   explicit message; EPUB and DOCX still work.

Nothing else is platform-specific: no symlinks, no POSIX shell, no `make`. The
`npm` scripts are plain `node` invocations. Use `npm.cmd`/`node` from PowerShell,
or Git Bash if you prefer.

## 5. Ubuntu / Linux

```bash
# Node 22 or 24 — the distro package is usually too old
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs poppler-utils
curl -fsSL https://ollama.com/install.sh | sh
ollama pull llama3.1:8b
ollama pull nomic-embed-text
```

`nvm` works equally well; anything `>=22.18.0` is fine. `poppler-utils` supplies
`pdftotext` and `pdfinfo`.

## 6. Development

```bash
git clone https://github.com/Jacob-Bouchillon/FanFable.git
cd FanFable
npm ci          # TypeScript + @types/node, no runtime deps
npm run typecheck
npm test
```

- `npm test` runs `node --test "testing/tests/*.test.ts"`. The suite is offline:
  it uses `MockProvider` and temporary databases, so no model server is needed.
- `npm run typecheck` covers `fanfable/src` and the committed test suite.
- `npm run fanfable -- serve` starts the UI; `npm run fanfable -- help` lists the
  CLI.

The evaluation and benchmark scripts (`npm run eval:*`, `npm run bench:*`) are a
different tier: they need a live model and local corpora under
`testing/benchmarks/data/` and `RESOURCES/`. Those folders are intentionally not
in the repository — they hold books, run databases and blind-rating packets.

## 7. Verify a fresh machine

```bash
node -v              # v22.18.0 or newer
npm ci
npm run typecheck    # exits 0
npm test             # offline suite, 0 failing
pdftotext -v         # only if you import PDFs
ollama list          # shows the chat and embedding models
npm run fanfable -- llm status
```

`llm status` is the end-to-end check: it fails loudly if the model server is not
reachable or the configured model is not pulled.
