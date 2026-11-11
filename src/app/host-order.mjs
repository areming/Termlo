// Host order: the user's own arrangement (drag and drop) first, then new hosts by name.

const byName = (a, b) => a.name.localeCompare(b.name, 'zh-CN');

export function orderHosts(hosts, order = []) {
  const rank = new Map(order.map((id, i) => [id, i]));
  return hosts.slice().sort((a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id) : Infinity;
    const rb = rank.has(b.id) ? rank.get(b.id) : Infinity;
    return ra === rb ? byName(a, b) : ra - rb;
  });
}

// Move one host before or after another. Returns the full new order of host ids.
export function moveHost(hosts, order, movedId, targetId, after = false) {
  const ids = orderHosts(hosts, order).map(h => h.id).filter(id => id !== movedId);
  const index = ids.indexOf(targetId);
  if (index < 0 || movedId === targetId) return orderHosts(hosts, order).map(h => h.id);
  ids.splice(after ? index + 1 : index, 0, movedId);
  return ids;
}
