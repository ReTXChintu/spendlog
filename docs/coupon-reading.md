# Reading a coupon off a picture

SpendLog can look at a screenshot of a coupon or a card offer and fill in
the form for you. It reads the picture with a vision model running on your
own server — nothing leaves the box, and there is nothing to pay for.

**It fills the form in. It does not save anything.** A model that reads
"20% off up to ₹150" as "₹150 off" is wrong in a way you would not notice
until you were at a till with the wrong card out, so what comes back is a
draft for you to glance at. Checking six fields beats typing twelve.

## What you need

A model that can look at an image, and something to run it. On a KVM 8
(8 vCPU, 32 GB) the answer is Qwen2.5-VL 3B under llama.cpp, on the CPU.
No GPU is involved.

| | |
|---|---|
| RAM while loaded | ~3.5 GB |
| Disk | ~2.5 GB |
| First read after a restart | 40–90s — the weights load from disk |
| Every read after that | 15–40s |

7B is noticeably better at the fiddly ones and roughly twice as slow. The
setup is identical; swap the file names. Start with 3B.

## Installing it

```bash
# 1. llama.cpp, built for CPU
sudo apt install -y build-essential cmake libcurl4-openssl-dev
git clone https://github.com/ggml-org/llama.cpp ~/llama.cpp
cmake -B ~/llama.cpp/build -S ~/llama.cpp -DLLAMA_CURL=ON
cmake --build ~/llama.cpp/build --config Release -j $(nproc)

# 2. The model, and the part of it that reads images
mkdir -p ~/models
curl -L -o ~/models/qwen2.5-vl-3b-q4.gguf \
  https://huggingface.co/ggml-org/Qwen2.5-VL-3B-Instruct-GGUF/resolve/main/Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf
curl -L -o ~/models/qwen2.5-vl-3b-mmproj.gguf \
  https://huggingface.co/ggml-org/Qwen2.5-VL-3B-Instruct-GGUF/resolve/main/mmproj-Qwen2.5-VL-3B-Instruct-f16.gguf
```

The second file is the vision encoder. Without `--mmproj` the server
starts happily and then refuses every image, which is a confusing way to
find out you forgot it.

## Running it

Name the paths in the `.env` at the repo root and PM2 runs it for you, as
a third process beside the app:

```
VISION_BASE_URL="http://127.0.0.1:8081"
VISION_MODEL="qwen2.5-vl-3b"

VISION_SERVER_BIN="/root/llama.cpp/build/bin/llama-server"
VISION_MODEL_PATH="/root/models/qwen2.5-vl-3b-q4.gguf"
VISION_MMPROJ_PATH="/root/models/qwen2.5-vl-3b-mmproj.gguf"
VISION_THREADS="6"
```

Then:

```bash
npm run pm2:start     # brings up all three
pm2 save              # keeps them across a reboot
```

Leave any of the three paths empty and PM2 starts the usual two, on the
assumption you are running `llama-server` yourself or pointing
`VISION_BASE_URL` at something else. It also skips it silently if the
files are not where the paths say - a config naming a binary that is not
there would otherwise leave a permanently errored process in `pm2 list`,
and that is the sort of thing you stop noticing.

Three things the config decides for you, and why:

- **`--host 127.0.0.1`, always.** The model has no authentication of its
  own, so anything that can reach it can ask it anything. It is never on
  `0.0.0.0`.
- **Six threads, not eight.** Mongo, Node and the web server want a core
  each, and those are what you notice slowing down. Override with
  `VISION_THREADS`.
- **No `max_memory_restart`.** A 3B model holds three and a half gigabytes
  by design; a ceiling here would restart it for ever.

The button appears on the Perks page once the server can see a model; with
`VISION_BASE_URL` empty it stays hidden rather than offering something
that would fail.

## Checking it works

```bash
pm2 list                              # spendlog-vision should be online
pm2 logs spendlog-vision --lines 50   # says when the model is ready
curl -s http://127.0.0.1:8081/health
```

The first request after a start loads three gigabytes off disk, so give it
a minute before deciding it is broken.

## When it is wrong

It will be, sometimes — that is why it fills a form rather than saving.
The two worth knowing about:

- **A percentage and its cap read as two discounts.** "20% up to ₹150"
  becoming a flat ₹150. SpendLog already refuses to keep both, so you will
  see one or the other; check which.
- **Dates in Indian order.** 04/08/26 is the 4th of August. The prompt
  says so, and a small model still gets it wrong on a blurry photo.

If a picture reads badly, the fastest fix is usually a better picture:
crop to the coupon, and drop the screenshot rather than a photo of a
screen where you can.

## Using something else instead

`VISION_BASE_URL` points at anything that speaks the OpenAI chat API with
image content — Ollama, vLLM, LM Studio, or a hosted API with a key. The
provider lives in `perks.vision.ts` and is the only file that knows which;
swapping it is a config change rather than a rewrite.
