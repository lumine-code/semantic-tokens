// Maps semantic token names onto the conventional syntax--* compound classes
// emitted by the grammar layer (classNameForScopeId turns a scope like
// entity.name.function into "syntax--entity syntax--name syntax--function"), so
// existing themes color semantic tokens without knowing about them.

// The standard token types, each resolved to the scope existing grammars would
// assign the same construct. A provider naming something else gets the base
// class, which is colorless — themes are the authority on what a scope means.
const TYPE_CLASSES = {
  namespace: "syntax--entity syntax--name syntax--namespace",
  type: "syntax--entity syntax--name syntax--type",
  class: "syntax--entity syntax--name syntax--type syntax--class",
  enum: "syntax--entity syntax--name syntax--type syntax--enum",
  interface: "syntax--entity syntax--name syntax--type syntax--interface",
  struct: "syntax--entity syntax--name syntax--type syntax--struct",
  typeParameter: "syntax--entity syntax--name syntax--type syntax--parameter",
  parameter: "syntax--variable syntax--parameter",
  variable: "syntax--variable",
  property: "syntax--variable syntax--other syntax--property",
  enumMember: "syntax--constant syntax--other syntax--enum",
  event: "syntax--variable syntax--other syntax--event",
  function: "syntax--entity syntax--name syntax--function",
  method: "syntax--entity syntax--name syntax--function syntax--method",
  macro: "syntax--entity syntax--name syntax--function syntax--macro",
  keyword: "syntax--keyword",
  modifier: "syntax--storage syntax--modifier",
  comment: "syntax--comment",
  string: "syntax--string",
  number: "syntax--constant syntax--numeric",
  regexp: "syntax--string syntax--regexp",
  operator: "syntax--keyword syntax--operator",
  decorator: "syntax--entity syntax--name syntax--decorator",
};

// Modifiers only contribute a class where a conventional mapping exists;
// everything else (declaration, static, async, ...) is ignored.
const MODIFIER_CLASSES = {
  deprecated: "semantic-tokens-strike",
  // Standard-library names are what the support.* scopes mark in grammars.
  defaultLibrary: "syntax--support",
};

const BASE_CLASS = "semantic-tokens";
const BASE_PROPERTIES = Object.freeze({ type: "text", class: BASE_CLASS });

// One memo for the whole package: names mean the same thing whoever sent them,
// so a property object is shared across editors and providers alike.
const memo = new Map();

// Returns a memoized LayerDecoration override — overrides replace the base
// properties entirely, so every result carries type:"text" and the base class
// itself. Reusing the same object per (type, modifiers) keeps decoration
// comparisons cheap.
exports.propertiesFor = (type, modifiers = []) => {
  const key = `${type}:${modifiers.join(" ")}`;
  let properties = memo.get(key);
  if (properties) return properties;
  let className = BASE_CLASS;
  if (TYPE_CLASSES[type]) className += ` ${TYPE_CLASSES[type]}`;
  for (const modifier of modifiers)
    if (MODIFIER_CLASSES[modifier]) className += ` ${MODIFIER_CLASSES[modifier]}`;
  properties = className === BASE_CLASS ? BASE_PROPERTIES : { type: "text", class: className };
  memo.set(key, properties);
  return properties;
};
