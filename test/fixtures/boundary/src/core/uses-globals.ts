export function leak(): unknown {
  console.log(process.env.HOME);
  return fetch('https://example.com');
}
