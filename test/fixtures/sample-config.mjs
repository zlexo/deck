// The setup the tests are written against: three configured repos with their
// review rules and CI jobs, as a state.json would hold them. Deck ships with no
// repos configured; examples/state.example.json shows the same shape.
import { deepMerge } from '../../lib/core/config.mjs';

export const SAMPLE_STATE = {
  "repos": {
    "perdix": {
      "name": "Perdix",
      "slug": "zlexo/perdix",
      "path": "~/code/perdix",
      "project": "perdix"
    },
    "modplex": {
      "name": "Modplex",
      "slug": "zlexo/modplex",
      "path": "~/code/modplex",
      "project": "modplex"
    },
    "conduit": {
      "name": "Conduit",
      "slug": "zlexo/conduit",
      "path": "~/code/conduit",
      "project": "conduit"
    }
  },
  "reviews": {
    "repos": {
      "perdix": {
        "rules": [
          "CONTRIBUTING.md",
          "CLAUDE.md",
          "docs/design/0000-foundations.md"
        ],
        "design": "rfc",
        "risk": [
          "app/src/world_loop*",
          "engine/world/src/*stream*",
          "engine/render/src/*arena*",
          "engine/render/src/*upload*",
          "engine/core/src/job*"
        ]
      },
      "modplex": {
        "rules": [
          "CONTRIBUTING.md",
          "CLAUDE.md",
          "README.md"
        ],
        "design": "issues",
        "risk": [
          "apps/payments/**",
          "packages/db/**",
          "packages/db-ledger/**"
        ]
      },
      "conduit": {
        "rules": [
          "CONTRIBUTING.md",
          "CLAUDE.md",
          "PAIRED-RULES.md"
        ],
        "design": "issues",
        "risk": [
          "modules/conduit-core/**",
          "modules/conduit-instance/**"
        ]
      }
    }
  },
  "ci": {
    "repos": {
      "perdix": {
        "timeoutMin": 60,
        "jobs": [
          {
            "name": "ci-local",
            "cmd": [
              "scripts/ci-local.sh"
            ],
            "env": {
              "CLANG_FORMAT": "~/.ci-tools/bin/clang-format",
              "CLANG_TIDY": "~/.ci-tools/bin/clang-tidy",
              "JOBS": "3"
            },
            "requires": [
              "~/.ci-tools/bin/clang-format",
              "~/.ci-tools/bin/clang-tidy"
            ],
            "parse": "ci-local"
          }
        ]
      },
      "conduit": {
        "timeoutMin": 45,
        "jobs": [
          {
            "name": "check",
            "cmd": [
              "./gradlew",
              "check",
              "--no-daemon",
              "--stacktrace"
            ],
            "githubToken": true,
            "dropLines": "\\[\\+\\+ \\]",
            "parse": "gradle"
          },
          {
            "name": "changelog",
            "cmd": [
              "scripts/check-changelog-unreleased.sh",
              "{base}",
              "{sha}"
            ],
            "prOnly": true,
            "skipLabel": "no-changelog"
          }
        ]
      },
      "modplex": {
        "timeoutMin": 30,
        "jobs": [
          {
            "name": "npm ci",
            "cmd": [
              "npm",
              "ci"
            ]
          },
          {
            "name": "build",
            "cmd": [
              "npm",
              "run",
              "build"
            ]
          },
          {
            "name": "typecheck",
            "cmd": [
              "npm",
              "run",
              "typecheck"
            ]
          },
          {
            "name": "test:all",
            "cmd": [
              "npm",
              "run",
              "test:all"
            ],
            "parse": "vitest"
          },
          {
            "name": "build:runtime",
            "cmd": [
              "npm",
              "run",
              "build:runtime"
            ],
            "env": {
              "GRADLE_OPTS": "-Dorg.gradle.daemon=false"
            },
            "onlyIfChanged": [
              "runtime/"
            ]
          }
        ]
      }
    }
  }
};

// The sample with a test's own settings on top (objects merge, arrays replace).
export const withSample = (state = {}) => deepMerge(SAMPLE_STATE, state);
