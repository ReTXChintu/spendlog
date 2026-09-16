import { env } from "../../env";

/**
 * Whatever is reading the picture.
 *
 * One interface with the model behind it, because the choice is going to
 * change. Right now it is Qwen2.5-VL on the VPS, reached over localhost
 * through llama.cpp's OpenAI-shaped endpoint; a hosted API would be a
 * different implementation of the same two lines and nothing above here
 * would notice.
 *
 * Nothing in this file knows what a coupon is. It takes an image and a
 * question and hands back whatever the model said, so the part that does
 * know about coupons can be read, tested and argued with on its own.
 */

export interface VisionProvider {
  /// What to call it on screen when something goes wrong, so an error can
  /// say which model failed rather than "the model".
  readonly name: string;
  describe(params: { image: Buffer; mimeType: string; prompt: string }): Promise<string>;
}

export class VisionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VisionUnavailableError";
  }
}

/**
 * A 3B model on eight CPU cores takes tens of seconds for one image, and
 * two at once take four times as long rather than twice - they fight over
 * the same cores and the same memory bandwidth. So one at a time, and a
 * queue for anybody who asks while it is busy.
 */
let inFlight: Promise<unknown> = Promise.resolve();

function oneAtATime<T>(run: () => Promise<T>): Promise<T> {
  const next = inFlight.then(run, run);
  // Kept off the chain so one failure does not poison every request after
  // it, and unhandled-rejection warnings do not fire for a chain nobody
  // is awaiting.
  inFlight = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

/**
 * llama.cpp's server, which speaks enough of the OpenAI chat API to take
 * an image as a data URL.
 *
 * Deliberately not streaming. There is one JSON object at the end of this
 * and nobody watching it arrive - the useful progress to show is "reading
 * it", which the client can say on its own.
 */
class LlamaCppVision implements VisionProvider {
  readonly name: string;

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly timeoutMs: number
  ) {
    this.name = model;
  }

  async describe({
    image,
    mimeType,
    prompt,
  }: {
    image: Buffer;
    mimeType: string;
    prompt: string;
  }): Promise<string> {
    return oneAtATime(async () => {
      // A local model is slow rather than unreliable, so the timeout is
      // generous and the failure it catches is a server that is not
      // running at all.
      const abort = AbortSignal.timeout(this.timeoutMs);

      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: abort,
          body: JSON.stringify({
            model: this.model,
            // Zero, because this is transcription rather than writing. A
            // coupon's expiry is not a thing to be creative about.
            temperature: 0,
            max_tokens: 700,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "image_url",
                    image_url: { url: `data:${mimeType};base64,${image.toString("base64")}` },
                  },
                  { type: "text", text: prompt },
                ],
              },
            ],
          }),
        });
      } catch (error) {
        throw new VisionUnavailableError(
          error instanceof Error && error.name === "TimeoutError"
            ? `The model took longer than ${Math.round(this.timeoutMs / 1000)}s. A first run loads ` +
              "the weights from disk and is much slower than the ones after it."
            : `Could not reach the model at ${this.baseUrl}. Is llama-server running?`
        );
      }

      if (!response.ok) {
        throw new VisionUnavailableError(
          `The model answered ${response.status}. ${await response.text().catch(() => "")}`.trim()
        );
      }

      const body = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
      };

      const said = body.choices?.[0]?.message?.content;
      if (!said) throw new VisionUnavailableError("The model answered with nothing.");

      return said;
    });
  }
}

/**
 * The provider this deployment is configured for, or null when none is.
 *
 * Null rather than throwing: reading a picture is an extra way to add a
 * coupon and never the only one, so a server without a model set up
 * should hide the button rather than break the page.
 */
export function visionProvider(): VisionProvider | null {
  if (!env.visionBaseUrl) return null;

  return new LlamaCppVision(
    env.visionBaseUrl.replace(/\/+$/, ""),
    env.visionModel,
    env.visionTimeoutMs
  );
}
