module.exports = {
  root: true,
  env: {
    es6: true,
    node: true,
  },
  extends: [
    "eslint:recommended",
    "@typescript-eslint/recommended",
  ],
  parser: "@typescript-eslint/parser",
  parserOptions: {
    project: ["tsconfig.json", "tsconfig.dev.json"],
    sourceType: "module",
  },
  ignorePatterns: [
    "/lib/**/*",
    "/generated/**/*",
  ],
  plugins: [
    "@typescript-eslint",
  ],
  rules: {
    // Turn off annoying formatting rules
    "indent": "off",
    "quotes": "off",
    "max-len": "off",
    "comma-dangle": "off",
    "object-curly-spacing": "off",
    "semi": "off",
    
    // Keep useful rules that catch actual bugs
    "no-unused-vars": "off", // Turn off base rule
    "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }],
    "@typescript-eslint/no-explicit-any": "warn",
    "no-console": "warn",
  },
};