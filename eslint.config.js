import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores(["dist", "docs/prototypes"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    // Destructuring a field out to leave the rest (`const { gap, ...shared } = finding`) is how a key is dropped
    // immutably, so the dropped name is not an unused variable.
    rules: { "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }] },
  },
]);
