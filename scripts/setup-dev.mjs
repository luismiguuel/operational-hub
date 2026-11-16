/* global console, process, URL */
import fs from 'node:fs';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
const parse = (text) =>
  Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((line) => line.includes('=') && !line.startsWith('#'))
      .map((line) => {
        const i = line.indexOf('=');
        return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
      }),
  );
const probe = (host, port) =>
  new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
async function main() {
  const setup = process.argv[2] === 'setup';
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13))
    throw new Error('Use Node >=22.13. Execute nvm install 22 e nvm use.');
  if (setup && !fs.existsSync('.env')) fs.copyFileSync('.env.example', '.env');
  if (!fs.existsSync('.env')) throw new Error('Arquivo .env ausente. Execute pnpm setup.');
  const env = parse(fs.readFileSync('.env', 'utf8'));
  for (const key of [
    'DATABASE_URL',
    'REDIS_URL',
    'WEB_ORIGIN',
    'JWT_SECRET',
    'SEED_ADMIN_EMAIL',
    'SEED_ADMIN_PASSWORD',
  ])
    if (!env[key])
      throw new Error('Preencha ' + key + ' no .env. Execute pnpm setup para configurar.');
  if (env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET precisa ter 32 caracteres ou mais.');
  if (env.SEED_ADMIN_PASSWORD.length < 12)
    throw new Error('SEED_ADMIN_PASSWORD precisa ter 12 caracteres ou mais.');
  const example = parse(fs.readFileSync('.env.example', 'utf8'));
  for (const key of Object.keys(example))
    if (!(key in env)) console.warn('AVISO chave ' + key + ' ausente; confira .env.example.');
  console.log('OK Node e configuração obrigatória.');
  const run = (command, args) => {
    const result = spawnSync(command, args, { stdio: 'inherit' });
    if (result.error || result.status !== 0)
      throw new Error('Falha ao executar ' + command + '. Verifique Docker e configuração local.');
  };
  const docker = spawnSync('docker', ['info'], { stdio: 'ignore' });
  if (setup && docker.status === 0) run('docker', ['compose', 'up', '-d', '--wait']);
  else if (docker.status !== 0)
    console.log('AVISO Docker indisponível; inicie Docker ou use serviços externos.');
  for (const [key, fallback] of [
    ['DATABASE_URL', 5432],
    ['REDIS_URL', 6379],
  ]) {
    const url = new URL(env[key]);
    const ok = await probe(url.hostname, Number(url.port || fallback));
    console.log((ok ? 'OK ' : 'AVISO ') + key + (ok ? ' acessível.' : ' offline.'));
    if (setup && !ok) throw new Error('Inicie os serviços antes de continuar.');
  }
  for (const port of [Number(env.PORT || 3001), 5173])
    console.log(
      (await probe('127.0.0.1', port))
        ? 'AVISO porta ' + port + ' ocupada.'
        : 'OK porta ' + port + ' livre.',
    );
  if (setup) {
    run('pnpm', ['db:migrate']);
    run('pnpm', ['db:seed']);
    console.log('Login local: ' + env.SEED_ADMIN_EMAIL + ' / ' + env.SEED_ADMIN_PASSWORD);
    console.log(
      'Contas existentes preservam a senha anterior. Execute pnpm dev e, em outro terminal, pnpm worker.',
    );
  }
}
main().catch((error) => {
  console.error('ERRO: ' + error.message);
  process.exitCode = 1;
});
