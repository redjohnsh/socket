# @rj/socket

`@rj/socket` is a TypeScript library that provides a robust WebSocket wrapper with built-in features such as automatic reconnection, data decoding, and an easy-to-use async iterable interface. This library is designed to simplify working with WebSockets in TypeScript and JavaScript applications by offering a set of powerful utilities to manage WebSocket connections more effectively.

## Features

- **Automatic Reconnection**: Automatically attempts to reconnect to the WebSocket server on connection loss, with configurable retry attempts and delay.
- **Data Encoding / Decoding**: Supports custom data decoding using the `encode` / `decode` function, allowing integration with libraries like `zod`, `MessagePack`, and more.
- **Async Iteration**: Implements `AsyncIterable`, allowing you to use `for await...of` to process incoming WebSocket messages easily.
- **Error Handling**: Customizable error handling through the `onError` callback.
- **Automatic Resource Cleanup**: Implements `AsyncDisposable`, enabling you to use `await using` syntax with `Socket.connect(...)`. This ensures that the WebSocket connection is automatically disconnected when it goes out of scope, simplifying resource management in asynchronous functions.

## Installation

```sh
# bun
bunx jsr add @rj/socket

# deno
deno add @rj/socket

# npm
npx jsr add @rj/socket
```

## Usage

### Event-driven example

```ts
import { Socket } from "@rj/socket";

const socket = Socket.connect("wss://example.com/ws");

// Returns a cleanup function.
const unsubscribe = socket.subscribe((data) => {});
```

### Async Iterable

```ts
import { Socket } from "@rj/socket";

async function main(): Promise<void> {
  const socket = Socket.connect("wss://example.com/ws", {
    decode: (data) => JSON.parse(String(data)),
  });

  // Socket implements `AsyncIterable` so you can use `for await..of` syntax.
  for await (const msg of socket) {
    // Process message
  }

  // Manually disconnect
  socket.disconnect();
}
```

### Explicit Resource Management

```ts
import { Socket } from '@rj/socket';

async function main(): Promise<void> {
  // New `using` syntax.
  await using socket = Socket.connect('wss://example.com/ws', {
    decode: (data) => JSON.parse(String(data))
  });

  for await (const msg of socket) {
    // Process message
  }

  // At the end of the scope, right after this line, the connection will be automatically drop and all listeners will be cleared.
}
```

## Going Type-Safe

### Usage With Zod

```ts
import { Socket } from "@rj/socket";
import { z } from "zod";

const IncomingMessageSchema = z
  .object({
    type: z.literal("user-connected"),
    userId: z.number(),
  })
  .or(
    z.object({
      type: z.literal("new-message"),
      text: z.string(),
    })
  );

const socket = Socket.connect("wss://example.com/ws", {
  decode(data) {
    const json = JSON.parse(data);
    return IncomingMessageSchema.parse(json);
  },
});

//    ^? Socket<{ type: 'user-connected'; userId: number } | { type: 'new-message'; text: string }>

socket.subscribe((msg) => {
  // Since we're using `type` as a discriminator, using a switch statement here
  // will result in fully typed data.
  switch (msg.type) {
    case "user-connected": {
      handleUserConnected(msg.userId);
      break;
    }
    case "new-message":
      handleNewMessage(msg.text);
      break;
  }
});
```

### Usage With MessagePack

```ts
import { Socket } from "@rj/socket";
import { encode, decode } from "@msgpack/msgpack";

const socket = Socket.connect("wss://example.com/ws", {
  binaryType: "arraybuffer", // <- Set this.
  decode(data) {
    const binary = new Uint8Array(data);
    // Decode using MessagePack
    return decode(binary);
  },
  encode(data) {
    // Encode using MessagePack
    return encode(data);
  },
});

// Or you can combine MessagePack with zod or any other validation library.
const socket = Socket.connect("wss://example.com/ws", {
  binaryType: "arraybuffer",
  decode: (data) => {
    const binary = new Uint8Array(data);
    // Decode using MessagePack
    const decoded = decode(binary);
    // Parse using zod
    return IncomingMessageSchema.parse(decoded);
  },
});
```

## Automatic Reconnection

```ts
import { Socket } from "@rj/socket";

const socket = Socket.connect("wss://example.com/ws", {
  reconnectAttempts: 5 // <- Default is `Infinity`,
  reconnectDelay: 5000 // <- Default is 1000 (1 second).
});
```
