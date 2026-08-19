# semantic-tokens

Layer semantic highlighting over the grammar's own.

Tokens come from provider packages — typically language-server backends — and color identifiers by what they mean rather than by how they are spelled, so a parameter reads differently from a local and a class differently from a namespace.

## Features

- **Semantic classification**: colors each identifier by the classification its provider computed, which a grammar alone cannot know.
- **Theme-ready**: decorates with the conventional `syntax--*` classes, so the theme you already use colors semantic tokens without knowing they exist.
- **Augments the grammar**: layers over the existing highlighting rather than replacing it, so an unclassified identifier keeps the color it had.
- **Big-file budgets**: switches to the visible rows past a size budget, and steps aside entirely when the provider cannot serve ranges.
- **Deprecated strike**: draws a deprecation as a background line, so a linter underline on the same span survives beside it.
- **Per language**: on everywhere by default, and can be switched off for one language and not the rest through scoped settings.

## Installation

To install `semantic-tokens` search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/semantic-tokens`.

## Commands

Commands available in `lumine-workspace`:

- `semantic-tokens:toggle`: turn the semantic highlighting layered over the grammar on or off,
- `semantic-tokens:refresh`: ask the providers for the active file's tokens again.

## Customization

Semantic tokens can be styled in the `styles.css` file, e.g. italicize the parameters a server identified:

```css
.semantic-tokens.syntax--parameter {
  font-style: italic;
}
```

## Services

- [`semantic-tokens.provider`](docs/semantic-tokens.provider.md): consumed to collect the classification of the identifiers, from providers such as IDE backend packages.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
