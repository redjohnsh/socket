export type SocketState =
	| "connected"
	| "connecting"
	| "disconnecting"
	| "disconnected"
	| "reconnecting";

export interface SocketOptions<T> {
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
	 */
	decode: (data: unknown) => T | Promise<T>;

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

function isInfinity(value: number): boolean {
	return (
		value === Number.POSITIVE_INFINITY || value === Number.NEGATIVE_INFINITY
	);
}

/**
 * Class representing a WebSocket connection with automatic reconnection and subscription handling.
 *
 * @template T
 * @implements {AsyncIterable<T>}
 * @implements {AsyncDisposable}
 */
export class Socket<T = unknown> implements AsyncIterable<T>, AsyncDisposable {
	#binaryType?: BinaryType;
	#currentAttempts = 0;
	#hasConnectedOnce = false;
	#isManuallyClosed = false;
	#logger = false;
	#onError?: (error: unknown) => void;
	#decode: (data: unknown) => T | Promise<T>;
	#reconnectAttempts: number;
	#reconnectDelay: number;
	#socket: WebSocket;
	#subscriptions = new Set<(data: T) => void>();
	#timer?: Timer;
	#url: string;

	/**
	 * Private constructor for the Socket class.
	 *
	 * @param {string} url - The URL to connect to.
	 * @param {SocketOptions<T>} options - The options for the socket connection.
	 * @private
	 */
	private constructor(url: string, options: SocketOptions<T>) {
		const {
			binaryType,
			logger = false,
			onError,
			decode,
			reconnectAttempts = Number.POSITIVE_INFINITY,
			reconnectDelay = 1000,
		} = options;

		this.#binaryType = binaryType;
		this.#logger = logger;
		this.#onError = onError;
		this.#decode = decode;
		this.#reconnectAttempts = reconnectAttempts;
		this.#reconnectDelay = reconnectDelay;

		this.#url = url;
		this.#socket = this.#createSocket();
	}

	/**
	 * Implements the AsyncIterator protocol to allow iteration over incoming messages.
	 *
	 * @returns {AsyncIterator<T>} - An async iterator for incoming messages.
	 */
	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		const queue: T[] = [];
		let currentResolver = Promise.withResolvers<T>();

		this.subscribe((data) => {
			if (queue.length === 0) {
				currentResolver.resolve(data);
				currentResolver = Promise.withResolvers<T>();
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
		return new Promise<void>((resolve) => {
			const checkState = () => {
				if (this.isDisconnected()) {
					resolve();
				} else {
					queueMicrotask(checkState);
				}
			};
			checkState();
		});
	}

	/**
	 * Creates and returns a new Socket instance.
	 *
	 * @template T
	 * @param {URL | string} url - The URL to connect to.
	 * @param {SocketOptions<T>} options - The options for the socket connection.
	 * @returns {Socket<T>} - A new Socket instance.
	 */
	static connect<T>(url: URL | string, options: SocketOptions<T>): Socket<T> {
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

		if (this.#isManuallyClosed || !this.#hasConnectedOnce) return;
		if (this.#currentAttempts < this.#reconnectAttempts) {
			this.#log(
				`trying to reconnect (${this.#currentAttempts + 1}/${isInfinity(this.#reconnectAttempts) ? "∞" : this.#reconnectAttempts})`,
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

		let data: T;

		try {
			data = await this.#decode(ev.data);
		} catch (err) {
			this.#log("failed to parse data using provided `decode` function");
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
	 * @param {(data: T) => void} listener - The callback function to handle incoming data.
	 * @returns {() => void} - A function to unsubscribe the listener.
	 */
	public subscribe(listener: (data: T) => void): () => void {
		this.#subscriptions.add(listener);
		return () => {
			this.#subscriptions.delete(listener);
		};
	}
}
