# semantic-tokens.provider

Supplies the classification of the identifiers rendered over the grammar's highlighting.

|             |                                                                     |
| ----------- | ------------------------------------------------------------------- |
| Version     | `1.0.0`                                                             |
| Provided by | `provideSemanticTokens()` returning one provider                    |
| Consumed by | `consumeSemanticTokens(provider)` returning a `Disposable`          |
| Owner       | [`semantic-tokens`](https://github.com/lumine-code/semantic-tokens) |

If your tokens come from a language server, register an adapter with `ide-client` instead — it already provides this service on every adapter's behalf. Implement this directly only for a source that is not LSP: a compiler you already run, an index of your own.

## Registration

In your `package.json`:

```json
{
  "providedServices": {
    "semantic-tokens.provider": {
      "versions": { "1.0.0": "provideSemanticTokens" }
    }
  }
}
```

## Contract

```ts
type SemanticTokensProvider = {
  semanticTokens(editor: TextEditor): Promise<SemanticToken[] | null> | SemanticToken[] | null;
  semanticTokensInRange?(
    editor: TextEditor,
    range: [number, number],
  ): Promise<SemanticToken[] | null> | SemanticToken[] | null;
  onDidInvalidate?(callback: (event: { editor?: TextEditor }) => void): Disposable;
  grammarScopes?: string[] | Set<string>;
  priority?: number;
};

type SemanticToken = {
  row: number;
  column: number;
  length: number;
  type: string | null;
  modifiers?: string[];
};
```

Required members:

| Member                   | Description                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| `semanticTokens(editor)` | Every token in the buffer, or `null` when you cannot classify the whole document. See Modes. |

Optional members:

| Member                                 | Description                                                                                          |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `semanticTokensInRange(editor, range)` | The tokens inside the row range. Leaving it out, or returning `null`, means you cannot serve ranges. |
| `onDidInvalidate(callback)`            | Announce that your tokens went stale. Pass `{editor}` to refetch one, nothing to refetch all.        |
| `grammarScopes`                        | Scope names you serve. **Omitting it means every grammar.** May be a getter — see Behavior.          |
| `priority`                             | Decides who classifies an editor when several could. Defaults to `0`; `ide-client` uses `2`.         |

A token is **single-line**: `row` and `column` are buffer coordinates, and `length` counts characters from there. A zero length renders nothing and is skipped. Tokens may arrive in any order but must not overlap — an overlap makes two classifications share one span, which is a classification neither of them sent.

`type` is a name, not an index: `"keyword"`, `"parameter"`, `"enumMember"`. The standard names are the ones LSP defines, and each maps to the `syntax--*` classes a grammar would put on the same construct, so a theme colors semantic tokens without knowing they exist. A name outside that set — or `null` — renders unclassified rather than wrongly classified.

`modifiers` are names too, and only two of them draw anything today: `deprecated` strikes the token through, and `defaultLibrary` marks it as `syntax--support`. Send the rest anyway; they cost nothing and a later release may spell them.

## Modes

The consumer decides how much of the buffer to ask for, and the provider only answers:

- **Whole document** is the default, and `semanticTokens(editor)` is asked.
- **Viewport only** is what a large file gets — past 5000 lines, or once a whole-document answer came back with more than 20000 tokens. `semanticTokensInRange(editor, [startBufferRow, endBufferRow])` is asked instead, with an inclusive row range covering the screen plus a margin.

Viewport-only mode is **sticky for that editor**: once a budget trips, the whole-document request is not retried, because it would only trip the budget again. Each scroll then asks for the rows that came into view.

A provider that cannot serve ranges gets asked for the whole document until a budget trips, and then steps aside — the editor renders no semantic tokens at all rather than paying for a marker per token in a huge file.

## Return outcomes

Three answers, and each says something different about what is already on screen:

| Return             | Meaning                                                       | What happens                                                        |
| ------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------- |
| An array           | This is the classification.                                   | Rendered, replacing what was there.                                 |
| `null`             | You cannot serve this editor now — no session, no support.    | The next provider is asked; if none serves, the tokens are cleared. |
| A rejected promise | Something failed transiently: a server reindexing, a timeout. | What is on screen stays until the next fetch.                       |

Reserve `null` for "there is genuinely nothing here". Returning it where a rejection belongs makes the highlighting blink out whenever a server is busy.

## Minimal example

```js
module.exports = {
  provideSemanticTokens() {
    return {
      grammarScopes: ["source.mylang"],
      async semanticTokens(editor) {
        const symbols = await classify(editor.getText());
        return symbols.map(({ row, column, name, kind, isDeprecated }) => ({
          row,
          column,
          length: name.length,
          type: kind,
          modifiers: isDeprecated ? ["deprecated"] : [],
        }));
      },
    };
  },
};
```

## Behavior

**One provider classifies an editor.** They are tried in descending `priority`, and the first that does not decline owns it; nobody else is asked. This is unlike the hub contracts that fan in, and the reason is the rendering: two token sets over the same rows would merge their classes onto one span.

Tokens are fetched when an editor is opened, when the buffer stops changing, when the grammar changes, and — in viewport-only mode — when scrolling settles. Markers are rebuilt from the answer each time rather than diffed, in batches that yield to the main thread so a large file cannot freeze the window.

`grammarScopes` is **read through on every call, never snapshotted**. That is deliberate: a hub provider exposes it as a getter whose value changes as language server sessions come and go. A plain array is fine for a fixed set of grammars, but do not assume the registry cached it.

Rendering is gated by the scoped `semantic-tokens.enabled` setting — on by default, so a user can switch it off for one language and not for the rest. While it is off no provider is asked at all, so an expensive provider costs nothing where nobody wants it.

## Teardown

`consumeSemanticTokens` returns a `Disposable` that removes the provider from the registry and drops whatever it had rendered. Return it from your own consumer method or add it to your collection; nothing else is held on your behalf.

The `Disposable` returned by `onDidInvalidate` is disposed for you when the provider is removed.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
