/** The sky dome's shaders: a horizon-to-zenith gradient, the sun's glow and disc, stars and moon. */
export const skyVert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * p;
  gl_Position.z = gl_Position.w;
}
`

export const skyFrag = /* glsl */ `
uniform vec3 zenith;
uniform vec3 horizon;
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform float sunGlow;
uniform float stars;
uniform float moon;
uniform vec3 moonDir;
varying vec3 vDir;
float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
void main() {
  vec3 d = normalize(vDir);
  float h = max(d.y, 0.0);
  vec3 col = mix(horizon, zenith, pow(smoothstep(-0.02, 0.55, h), 0.7));
  float s = max(dot(d, sunDir), 0.0);
  col += sunColor * (pow(s, 6.0) * 0.35 + pow(s, 64.0) * 0.6) * sunGlow;
  col += sunColor * smoothstep(0.9993, 0.9997, s) * 6.0 * step(0.0, sunDir.y) * (1.0 - moon);
  if (stars > 0.0) {
    vec3 q = floor(d * 380.0);
    float r = hash(q);
    float tw = step(0.9975, r) * smoothstep(0.02, 0.25, d.y);
    col += vec3(0.9, 0.95, 1.0) * tw * stars * (0.6 + 0.4 * hash(q + 7.0)) * 1.4;
  }
  if (moon > 0.0) {
    float m = max(dot(d, moonDir), 0.0);
    col += vec3(0.85, 0.9, 1.0) * smoothstep(0.99955, 0.99975, m) * 3.0 * moon;
    col += vec3(0.4, 0.5, 0.9) * pow(m, 40.0) * 0.25 * moon;
  }
  // below horizon fades into fog colour
  col = mix(col, horizon, smoothstep(0.0, -0.08, d.y));
  gl_FragColor = vec4(col, 1.0);
}
`
