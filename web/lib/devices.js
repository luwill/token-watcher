export function usageUrl(path, params, device = 'all') {
  if (!['all', 'local', 'vps', 'windows', 'unknown'].includes(device)) throw new Error('Invalid device');
  return `${path}?${new URLSearchParams({ ...params, device })}`;
}
