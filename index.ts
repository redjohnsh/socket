/**
 * Represents the state of the WebSocket connection.
 * Can be one of the following:
 * - `"connected"`: The WebSocket is open and ready to communicate.
 * - `"connecting"`: The WebSocket is in the process of connecting.
 * - `"disconnecting"`: The WebSocket is in the process of closing.
 * - `"disconnected"`: The WebSocket is closed and no longer communicating.
 * - `"reconnecting"`: The WebSocket is attempting to reconnect after a disconnection.
 */
export type SocketState =
  | "connected"
  | "connecting"
  | "disconnecting"
  | "disconnected"
  | "reconnecting";

/**
 * Represents the type of data that can be sent or received through the WebSocket.
 * Can be a string, Blob, ArrayBuffer, or ArrayBufferView.
 */
type SocketData = string | Blob | ArrayBufferLike | ArrayBufferView;

/**
 * A function that decodes incoming WebSocket data.
 *
 * @template T - The type to which the data should be decoded.
 * @param {SocketData} data - The raw data received from the WebSocket.
 * @returns {T | Promise<T>} - The decoded data, either synchronously or as a promise.
 */
type DecodeFn<T> = (data: SocketData) => T | Promise<T>;

/**
 * A function that encodes data to be sent through the WebSocket.
 *
 * @template T - The type of data to be encoded.
 * @param {T} data - The data to be encoded.
 * @returns {SocketData | Promise<SocketData>} - The encoded data, either synchronously or as a promise.
 */
type EncodeFn<T> = (data: T) => SocketData | Promise<SocketData>;

const DEFAULT_DECODE_FN: DecodeFn<SocketData> = (data) => data;
const DEFAULT_ENCODE_FN: EncodeFn<unknown> = (data) => String(data);

export interface SocketOptions<Outgoing, Incoming> {
  /**
   * Specifies the type of binary data being transmitted over the WebSocket.
   * This can be either `"blob"` or `"arraybuffer"`.
   */
  binaryType?: BinaryType;

  /**
   * Flag to enable or disable logging. If `true`, the socket will log connection events and errors to the console.
   * Default is `false`.
   */
  logger?: boolean;

  /**
   * Callback function that is invoked when an error occurs. The function receives the error as its argument.
   */
  onError?: (error: unknown) => void;

  /**
   * Function to decode incoming data. The function receives the raw data and should return the decoded value,
   * either synchronously or as a promise.
   *
   * @type {DecodeFn<Incoming>}
   */
  decode?: DecodeFn<Incoming>;

  /**
   * Function to encode outgoing data before sending it over the WebSocket.
   * The function receives the raw data and should return the encoded value,
   * either synchronously or as a promise.
   *
   * @type {EncodeFn<Outgoing>}
   */
  encode?: EncodeFn<Outgoing>;

  /**
   * The number of reconnection attempts the socket should make if the connection is lost.
   * Defaults to `Infinity`, meaning it will keep trying indefinitely.
   */
  reconnectAttempts?: number;

  /**
   * The delay between reconnection attempts, in milliseconds. Defaults to 1000ms (1 second).
   */
  reconnectDelay?: number;
}

/**
 * Determines if a given number is either positive or negative infinity.
 *
 * @param {number} value - The value to check.
 * @returns {boolean} - Returns `true` if the value is infinite, `false` otherwise.
 */
function isInfinity(value: number): boolean {
  return (
    value === Number.POSITIVE_INFINITY || value === Number.NEGATIVE_INFINITY
  );
}

/**
 * Class representing a WebSocket connection with automatic reconnection and message subscription handling.
 *
 * This class provides a robust WebSocket client implementation that supports automatic reconnection,
 * message subscriptions, and asynchronous iteration over incoming messages. It also allows
 * encoding and decoding of messages, and can be used in various asynchronous workflows,
 * including the `for-await-of` loop.
 *
 * @template Outgoing The type of outgoing messages to be sent through the socket.
 * @template Incoming The type of incoming messages to be received from the socket.
 * @implements {AsyncIterable<Incoming>}
 * @implements {AsyncDisposable}
 */
export class Socket<Outgoing, Incoming>
  implements AsyncIterable<Incoming>, AsyncDisposable
{
  #binaryType?: BinaryType;
  #currentAttempts = 0;
  #hasConnectedOnce = false;
  #isManuallyClosed = false;
  #logger = false;
  #onError?: (error: unknown) => void;
  #decode: DecodeFn<Incoming>;
  #encode: EncodeFn<Outgoing>;
  #reconnectAttempts: number;
  #reconnectDelay: number;
  #socket: WebSocket;
  #subscriptions = new Set<(data: Incoming) => void>();
  #timer?: Timer;
  #url: string;

  /**
   * Private constructor for the Socket class. Use the static `connect` method to create a new instance.
   *
   * @param {string} url - The URL to connect to.
   * @param {SocketOptions<Outgoing, Incoming>} options - The options for the socket connection.
   * @private
   */
  private constructor(url: string, options: SocketOptions<Outgoing, Incoming>) {
    const {
      binaryType,
      logger = false,
      onError,
      decode = DEFAULT_DECODE_FN,
      encode = DEFAULT_ENCODE_FN,
      reconnectAttempts = Number.POSITIVE_INFINITY,
      reconnectDelay = 1000,
    } = options;

    this.#binaryType = binaryType;
    this.#logger = logger;
    this.#onError = onError;
    this.#decode = decode as DecodeFn<Incoming>;
    this.#encode = encode;
    this.#reconnectAttempts = reconnectAttempts;
    this.#reconnectDelay = reconnectDelay;

    this.#url = url;
    this.#socket = this.#createSocket();
  }

  /**
   * Creates and returns a new Socket instance.
   *
   * @template Outgoing The type of outgoing messages.
   * @template Incoming The type of incoming messages.
   * @param {URL | string} url - The URL to connect to.
   * @param {SocketOptions<Outgoing, Incoming>} options - The options for the socket connection.
   * @returns {Socket<Outgoing, Incoming>} - A new Socket instance.
   */
  static connect<Outgoing = unknown, Incoming = SocketData>(
    url: URL | string,
    options: SocketOptions<Outgoing, Incoming> = {}
  ): Socket<Outgoing, Incoming> {
    return new Socket(url.toString(), options);
  }

  /**
   * Returns the current state of the socket connection.
   *
   * @returns {SocketState} - The current state of the socket.
   */
  get state(): SocketState {
    if (this.#timer) {
      return "reconnecting";
    }

    switch (this.#socket.readyState) {
      case 0:
        return "connecting";
      case 1:
        return "connected";
      case 2:
        return "disconnecting";
      case 3:
        return "disconnected";
    }
    throw new Error(`Impossible socket state: ${this.#socket.readyState}`);
  }

  /**
   * Logs messages to the console if logging is enabled.
   *
   * @param {...unknown} data - The data to log.
   * @private
   */
  #log(...data: unknown[]): void {
    if (this.#logger) {
      console.log("[Socket]", ...data);
    }
  }

  /**
   * Clears the reconnection timer, if any.
   *
   * @private
   */
  #clearTimer() {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /**
   * Creates and returns a new WebSocket instance.
   *
   * @returns {WebSocket} - A new WebSocket instance.
   * @private
   */
  #createSocket(): WebSocket {
    const socket = new WebSocket(this.#url);
    socket.onclose = this.#handleClose.bind(this);
    socket.onerror = this.#handleError.bind(this);
    socket.onmessage = this.#handleMessage.bind(this);
    socket.onopen = this.#handleOpen.bind(this);
    if (this.#binaryType) {
      socket.binaryType = this.#binaryType;
    }
    return socket;
  }

  /**
   * Handles the `close` event of the WebSocket.
   *
   * @param {CloseEvent} _ - The close event.
   * @private
   */
  #handleClose(_: CloseEvent): void {
    this.#clearTimer();

    if (this.#isManuallyClosed) {
      this.#log("connection closed");
      return;
    }

    // If the socket hasn't connected at least once, just skip the reconnection logic.
    // We could be trying to reconnect to a bad target. So in short, we have to stablish
    // a connection first before trying to reconnect.
    if (!this.#hasConnectedOnce) {
      return;
    }

    if (this.#currentAttempts < this.#reconnectAttempts) {
      this.#log(
        `trying to reconnect (${this.#currentAttempts + 1}/${
          isInfinity(this.#reconnectAttempts) ? "∞" : this.#reconnectAttempts
        })`
      );
      this.#timer = setTimeout(() => {
        this.#currentAttempts++;
        this.#socket = this.#createSocket();
      }, this.#reconnectDelay);
    }
  }

  /**
   * Handles the `error` event of the WebSocket.
   *
   * @param {Event} ev - The error event.
   * @private
   */
  #handleError(ev: Event): void {
    // Let's omit any errors while reconnecting.
    if (this.state === "reconnecting") return;

    // The initial connection never happened, so me can assume this error
    // is about us not being able to establish a connection.
    if (!this.#hasConnectedOnce) {
      this.#log(`could not estabish socket connection with "${this.#url}"`);
      this.#onError?.(ev);
      return;
    }

    this.#log("error ocurred");
    this.#onError?.(ev);
  }

  /**
   * Handles incoming messages from the WebSocket.
   *
   * @param {MessageEvent} ev - The message event.
   * @returns {Promise<void>}
   * @private
   */
  async #handleMessage(ev: MessageEvent): Promise<void> {
    this.#log("message received");

    // Skip message parsing if no subscriber is registered
    if (this.#subscriptions.size === 0) return;

    let data: Incoming;

    try {
      data = await this.#decode(ev.data);
    } catch (err) {
      this.#log("failed to decode socket data");
      this.#onError?.(err);
      return;
    }

    for (const subscriber of this.#subscriptions) {
      try {
        subscriber(data);
      } catch (err) {
        this.#log("caught error while running subscriber function");
        this.#onError?.(err);
      }
    }
  }

  /**
   * Handles the `open` event of the WebSocket.
   *
   * @param {Event} _ - The open event.
   * @private
   */
  #handleOpen(_: Event): void {
    this.#log("connection established");
    this.#hasConnectedOnce = true;
    this.#currentAttempts = 0;
    this.#clearTimer();
  }

  /**
   * Checks if the socket is currently connected.
   *
   * @returns {boolean} - Returns `true` if the socket is connected, `false` otherwise.
   */
  public isConnected(): boolean {
    return this.state === "connected";
  }

  /**
   * Checks if the socket is currently disconnected.
   *
   * @returns {boolean} - Returns `true` if the socket is disconnected, `false` otherwise.
   */
  public isDisconnected(): boolean {
    return this.state === "disconnected";
  }

  /**
   * Manually closes the socket connection and clears all subscriptions.
   */
  public disconnect(): void {
    this.#isManuallyClosed = true;
    this.#socket.close();
    // There's no way to reconnect once manually disconnected, so we can empty our subscriber list.
    this.#subscriptions.clear();
  }

  /**
   * Subscribes to incoming messages.
   *
   * @param {(data: Incoming) => void} listener - The callback function to handle incoming data.
   * @returns {() => void} - A function to unsubscribe the listener.
   */
  public subscribe(listener: (data: Incoming) => void): () => void {
    this.#subscriptions.add(listener);
    return () => {
      this.#subscriptions.delete(listener);
    };
  }

  /**
   * Sends a message through the WebSocket after encoding it.
   *
   * @param {Outgoing} data - The data to send.
   * @returns {Promise<void>} - A promise that resolves when the message is sent.
   */
  public async send(data: Outgoing): Promise<void> {
    try {
      const encoded = await this.#encode(data);
      this.#socket.send(encoded);
    } catch (err) {
      this.#log("failed to encode socket data");
      this.#onError?.(err);
    }
  }

  /**
   * Implements the AsyncIterator protocol to allow iteration over incoming messages.
   *
   * @returns {AsyncIterator<Incoming>} - An async iterator for incoming messages.
   */
  async *[Symbol.asyncIterator](): AsyncIterator<Incoming> {
    const queue: Incoming[] = [];
    let currentResolver = Promise.withResolvers<Incoming>();

    this.subscribe((data) => {
      if (queue.length === 0) {
        currentResolver.resolve(data);
        currentResolver = Promise.withResolvers<Incoming>();
      } else {
        queue.push(data);
      }
    });

    while (true) {
      if (this.isDisconnected()) break;
      const data = queue.shift();

      if (typeof data !== "undefined") {
        yield data;
      } else {
        yield await currentResolver.promise;
      }
    }
  }

  /**
   * Asynchronously disposes of the socket, ensuring the connection is closed.
   *
   * @returns {Promise<void>}
   */
  async [Symbol.asyncDispose](): Promise<void> {
    this.disconnect();
    const resolver = Promise.withResolvers<void>();
    const checkState = () => {
      if (this.isDisconnected()) {
        resolver.resolve();
      } else {
        queueMicrotask(checkState);
      }
    };
    checkState();
    return resolver.promise;
  }
}
