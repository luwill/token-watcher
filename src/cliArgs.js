import { DEFAULT_PORT } from './config.js';

const COMMANDS = [
  'scan', 'serve', 'today', 'sessions', 'wrapped', 'roi', 'doctor',
  'install-agent', 'uninstall-agent', 'uninstall', 'bar', 'leaderboard',
];

export function parseArgs(argv) {
  const args = { cmd: 'serve', port: DEFAULT_PORT, force: false };
  let hasCommand = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') { args.port = Number(argv[i + 1]) || DEFAULT_PORT; args.portExplicit = true; i++; }
    else if (a === '--force') args.force = true;
    else if (a === '--json') args.json = true;
    else if (a === '--light') args.light = true;
    else if (a === '--csv') args.csv = true;
    else if (a === '--git') args.git = true;
    else if (a === '--day') { args.day = argv[++i]; }
    else if (a === '--from') { args.from = argv[++i]; }
    else if (a === '--to') { args.to = argv[++i]; }
    else if (a === '--out' || a === '-o') { args.out = argv[++i]; }
    else if (a === '--year') { args.year = Number(argv[++i]); }
    else if (a === '--yes' || a === '-y') args.yes = true;
    else if (a === '--purge-data') args.purgeData = true;
    else if (a === '--no-open') args.noOpen = true;
    else if (a === '--url') { args.url = argv[++i]; }
    else if (a === '--version' || a === '-v') args.version = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('--')) { /* 未知 flag 忽略（历史行为） */ }
    else if (!hasCommand) {
      if (!COMMANDS.includes(a)) throw new Error(`未知命令：${a}（使用 --help 查看用法）`);
      args.cmd = a;
      hasCommand = true;
    } else (args.positionals ||= []).push(a); // 顶层命令只识别一次，后续保留为子命令/昵称
  }
  return args;
}
