import {Command, Flags} from '@oclif/core'

import {type ChannelClient, ChannelClientError, type ChannelClientOptions, withChannelClient} from './channel-client.js'

/**
 * Shared base for the `brv channel` subcommands. Owns the `--json` flag, the
 * daemon round-trip (`dispatch`), and channel error rendering (`handleError`).
 * Lives under `lib/` — not `commands/channel/` — so oclif does not treat it as
 * a subcommand. The `channelClientOptions` seam lets tests inject a transport
 * connector to drive the command in-process.
 */
export abstract class ChannelCommand extends Command {
  public static baseFlags = {
    json: Flags.boolean({description: 'Output the result as a JSON envelope'}),
  }

  /**
   * Returns the daemon client options for the round-trip. A configuration seam:
   * exposed so a caller (or test) can supply a transport connector instead of
   * the default daemon-aware one.
   */
  public channelClientOptions(): ChannelClientOptions {
    return {projectPath: process.cwd()}
  }

  /**
   * Sends `payload` to a `channel:*` event and returns the response. On a
   * {@link ChannelClientError} this routes through `handleError` (which exits
   * non-zero); other errors rethrow.
   */
  protected async dispatch<TResponse = unknown>(event: string, payload: unknown, asJson: boolean): Promise<TResponse> {
    try {
      return await withChannelClient<TResponse>(
        (client: ChannelClient) => client.request<TResponse>(event, payload),
        this.channelClientOptions(),
      )
    } catch (error) {
      return this.handleError(error, asJson)
    }
  }

  /**
   * Sends `payload` and renders the success response: a JSON envelope in
   * `--json` mode (optionally reshaped via `toJson`), otherwise `render`. Errors
   * route through `handleError`.
   */
  protected async dispatchAndRender<TResponse = unknown>(args: {
    asJson: boolean
    event: string
    payload: unknown
    render: (response: TResponse) => void
    toJson?: (response: TResponse) => unknown
  }): Promise<void> {
    let response: TResponse
    try {
      response = await withChannelClient<TResponse>(
        (client: ChannelClient) => client.request<TResponse>(args.event, args.payload),
        this.channelClientOptions(),
      )
    } catch (error) {
      return this.handleError(error, args.asJson)
    }

    if (args.asJson) {
      this.log(JSON.stringify(args.toJson === undefined ? response : args.toJson(response)))
      return
    }

    args.render(response)
  }

  /**
   * Renders a {@link ChannelClientError} and exits non-zero: a `{success, code,
   * error}` envelope in JSON mode, a `[CODE] message` line on stderr otherwise.
   * Non-channel errors are rethrown to oclif's default handler.
   */
  protected handleError(error: unknown, asJson: boolean): never {
    if (error instanceof ChannelClientError) {
      if (asJson) {
        this.log(JSON.stringify({code: error.code, error: error.message, success: false}))
      } else {
        this.logToStderr(`[${error.code}] ${error.message}`)
      }

      this.exit(1)
    }

    throw error
  }
}
