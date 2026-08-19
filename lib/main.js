const SemanticTokensManager = require("./semantic-tokens-manager");

module.exports = {
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
