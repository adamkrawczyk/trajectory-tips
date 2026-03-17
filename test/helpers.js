export function fakeEmbedder(text) {
  const dims = 16;
  const vec = new Array(dims).fill(0);

  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    vec[(i * 7 + code) % dims] += code * (i + 1);
    vec[(i * 11 + code) % dims] += code * 0.5;
  }

  const mag = Math.sqrt(vec.reduce((sum, value) => sum + (value * value), 0)) || 1;
  return Promise.resolve(vec.map((value) => value / mag));
}
