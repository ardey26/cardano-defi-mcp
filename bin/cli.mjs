#!/usr/bin/env node
/**
 * The one-command entry point.
 *
 *   claude mcp add cardano-defi -- npx -y github:ardey26/cardano-defi-mcp
 *
 * Plain JavaScript on purpose: this file is what npx runs, so it has to work
 * before anything is compiled and without tsx, which an installed package does
 * not carry. Everything it does is pick a mode and import the built entry point.
 *
 *   (no args)    combined local stdio server — defi tools + wallet + onboarding
 *   wallet       wallet-only stdio server (and `wallet gen [evm|cardano]`)
 *   serve-http   the keyless HTTP server, the same thing the hosted deploy runs
 *
 * The two modes that hold keys live in dist-wallet/; serve-http lives in dist/,
 * which contains no signing code at all. See the note in package.json's files.
 */

import { fileURLToPath } from 'node:url';

const MIN_NODE_MAJOR = 20;

const USAGE = `cardano-defi-mcp — Cardano DeFi MCP server

usage: cardano-defi-mcp [command]

  (no command)       start the local MCP server on stdio: the nine keyless DeFi
                     tools plus the signing wallet plus setup_wallet/configure.
                     This is what \`claude mcp add\` should spawn.
  wallet             start the wallet-only stdio server (signing tools only)
  wallet gen [evm|cardano]
                     create burner keys from the shell instead of from the agent
  serve-http         start the keyless HTTP server (PORT, default 3000)
  help, --help, -v, --version

Config, keys and the spend ledger live in ~/.cardano-defi-mcp/ unless you run
from a checkout, where .env.local and .wallet-state.json are used instead.

Register with Claude Code:
  claude mcp add cardano-defi -- npx -y github:ardey26/cardano-defi-mcp
`;

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (Number.isNaN(major) || major < MIN_NODE_MAJOR) {
    console.error(
      `cardano-defi-mcp needs Node ${MIN_NODE_MAJOR} or newer, but this is Node ${process.versions.node}. ` +
        `Install Node ${MIN_NODE_MAJOR}+ (https://nodejs.org) and run the command again — ` +
        'with nvm: `nvm install 20 && nvm use 20`.',
    );
    process.exit(1);
  }
}

function resolve(path) {
  return fileURLToPath(new URL(path, import.meta.url));
}

async function run() {
  checkNode();
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case undefined:
    case 'start': {
      const { main } = await import(resolve('../dist-wallet/wallet/combined.js'));
      return await main();
    }
    case 'wallet': {
      const { main } = await import(resolve('../dist-wallet/wallet/server.js'));
      return await main(rest);
    }
    case 'serve-http': {
      process.env.MCP_TRANSPORT = 'http';
      if (!process.env.PORT) process.env.PORT = '3000';
      const { main } = await import(resolve('../dist/server.js'));
      await main();
      return 0;
    }
    case '-v':
    case '--version': {
      const { createRequire } = await import('node:module');
      const pkg = createRequire(import.meta.url)('../package.json');
      console.log(pkg.version);
      return 0;
    }
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return 0;
    default:
      console.error(`unknown command '${command}'\n\n${USAGE}`);
      return 1;
  }
}

run()
  .then((code) => {
    if (code) process.exit(code);
  })
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`cardano-defi-mcp failed to start: ${message}`);
    if (/Cannot find module|ERR_MODULE_NOT_FOUND/.test(message)) {
      console.error(
        'The build output is missing. If you installed from a checkout, run `npm run build && npm run build:wallet`.',
      );
    }
    process.exit(1);
  });
