const SemanticTokensManager = require("./semantic-tokens-manager");

module.exports = {
  provideBackgroundTips() {
    return {
      packageName: "semantic-tokens",
      tips: [
        "{% if keys['semantic-tokens:toggle'] %}You can switch the semantic highlighting layer with {{ 'semantic-tokens:toggle' | keystroke }}{% else %}Semantic tokens color identifiers the way the language server understands them — a parameter apart from a local, a class apart from a namespace. They can be switched off per language in the settings.{% endif %}",
      ],
    };
  },

  activate() {
    this.manager = new SemanticTokensManager();
  },

  deactivate() {
    this.manager?.dispose();
    this.manager = null;
  },

  consumeSemanticTokens(provider) {
    return this.manager.registry.addProvider(provider);
  },
};
