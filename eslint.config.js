const customRules = require('./eslint-custom-rules');

module.exports = [
  {
    plugins: {
      custom: customRules
    }
  },
  {
    ignores: ["node_modules/**"],
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
    },
    rules: {
      // Detect duplicate keys in object literals
      "no-dupe-keys": "error",
      
      // Detect duplicate case labels in switch statements
      "no-duplicate-case": "error",
      
      // Detect unreachable code and code that will never execute
      "no-unreachable": "error",
      
      // Detect unused variables
      "no-unused-vars": "warn",
      
      // Detect assignments that could be confused with equality checks
      "no-cond-assign": "error",
      
      // Detect constant conditions
      "no-constant-condition": "warn",
      
      // Detect duplicate arguments in function definitions
      "no-dupe-args": "error",
      
      // Detect self-assignments
      "no-self-assign": "error",
      
      // Detect self-comparisons
      "no-self-compare": "error",
      
      // Detect useless expressions
      "no-unused-expressions": "warn",
      
      // Detect code paths that don't return values and inconsistent function returns
      "consistent-return": "warn",
      
      // Detect duplicate function implementations
      "no-dupe-class-members": "error",
      
      // Detect overwritten variables
      "no-shadow": "warn",
      
      // Detect functions that might have conflicting behavior
      "no-param-reassign": "warn",
      
      // Custom rule to detect potential duplicate methods
      "no-duplicate-imports": "error",
      
      // Custom rule to detect comments about duplicate methods
      "custom/no-duplicate-method-comment": "error",
      
      // Custom rule to detect references to potentially missing _notifyServer method
      "custom/detect-missing-notify-server": "warn",
      
      // Custom rule to detect redundant map initializations
      "custom/detect-redundant-map-initialization": "warn",
      
      // Custom rule to detect conflicting tone management
      "custom/detect-conflicting-tone-management": "warn",
      
      // Custom rule to detect cooldown mechanism conflicts
      "custom/detect-cooldown-mechanism-conflicts": "warn",
      
      // Custom rule to detect conversation starter conflicts
      "custom/detect-conversation-starter-conflicts": "warn",
    },
  },
];
