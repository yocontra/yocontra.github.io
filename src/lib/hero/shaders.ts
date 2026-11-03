/*
 * Domain-warped FBM "ink" field. The same algorithm is written twice:
 * WGSL for WebGPU and GLSL ES 3.0 for the WebGL2 fallback.
 *
 * Uniform layout (4 × vec4):
 *   U0 = res.xy, mouse.xy        U1 = vel.xy, time, scroll
 *   U2 = hue, vcr, phase, scale  U3 = warp, ascii, veins, grain
 *
 * `phase` is the flow time (∫ speed dt), integrated on the CPU so speed changes
 * never jump the field; `time` is wall-clock and only drives the grain.
 */

export const glslVertex = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`

export const glslFragment = /* glsl */ `#version 300 es
precision highp float;
uniform vec4 U[4];
out vec4 outColor;

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 m = rot(0.5);
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = m * p * 2.02 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return v;
}

vec3 oklch(float L, float C, float h) {
  float hr = radians(h);
  float a = C * cos(hr);
  float b = C * sin(hr);
  float l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  float m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  float s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  float l = l_ * l_ * l_;
  float m = m_ * m_ * m_;
  float s = s_ * s_ * s_;
  return max(vec3(
     4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s), 0.0);
}

// Returns the linear colour of the ink field at a fragment, plus |r| (used by VCR mode).
vec4 field(vec2 frag) {
  vec2 res = U[0].xy;
  float scroll = U[1].w;
  float hue = U[2].x;
  float t = U[2].z;

  vec2 uv = (frag - 0.5 * res) / res.y;
  vec2 p = uv * U[2].w * (1.0 + scroll * 0.5);
  p.y -= scroll * 1.2;

  vec2 q = vec2(fbm(p + vec2(0.0, t)), fbm(p + vec2(5.2, 1.3) - t * 0.7));
  vec2 r = vec2(fbm(p + U[3].x * q + vec2(1.7, 9.2) + t * 0.5),
                fbm(p + U[3].x * q + vec2(8.3, 2.8) - t * 0.4));
  float f = fbm(p + U[3].x * r);

  float vein = pow(1.0 - abs(2.0 * f - 1.0), U[3].z);

  vec3 base = oklch(0.12, 0.02, hue);
  vec3 ink = oklch(0.3, 0.09, hue + 25.0 * q.x);
  vec3 glow = oklch(0.88, 0.19, hue + 40.0 * r.y - 20.0);
  vec3 acc = oklch(0.5, 0.2, hue + 140.0);

  vec3 col = mix(base, ink, smoothstep(0.35, 0.85, f));
  col = mix(col, acc, smoothstep(0.75, 1.15, length(r)) * 0.6);
  col += glow * vein * (0.45 + 0.55 * q.y);

  col *= 1.0 - 0.45 * dot(uv, uv);
  col = mix(col, base * 0.8, smoothstep(0.0, 0.85, scroll) * 0.9);
  return vec4(col, length(r));
}

// 5x5 bitmap glyphs, darkest to brightest: . : * o & 8 @ #
float glyph(float g, vec2 p) {
  int n = 4096;
  if (g > 0.08) n = 65600;
  if (g > 0.16) n = 332772;
  if (g > 0.26) n = 15255086;
  if (g > 0.36) n = 23385164;
  if (g > 0.48) n = 15252014;
  if (g > 0.6) n = 13199452;
  if (g > 0.72) n = 11512810;
  p = floor(p * vec2(4.0, -4.0) + 2.5);
  if (clamp(p.x, 0.0, 4.0) != p.x || clamp(p.y, 0.0, 4.0) != p.y) return 0.0;
  int a = int(p.x + 5.0 * p.y);
  return float((n >> a) & 1);
}

void main() {
  vec2 res = U[0].xy;
  vec2 mouse = U[0].zw;
  vec2 vel = U[1].xy;
  float time = U[1].z;
  float scroll = U[1].w;
  float hue = U[2].x;
  float vcr = U[2].y;

  vec2 frag = gl_FragCoord.xy;
  vec2 uv = (frag - 0.5 * res) / res.y;

  // Around the cursor, the field is re-rendered as ASCII art.
  float speed = min(length(vel), 3.0);
  float radius = U[3].y * (0.22 + 0.06 * speed);
  float m = (1.0 - smoothstep(radius * 0.45, radius, length(uv - mouse)))
          * (1.0 - smoothstep(0.5, 1.0, scroll));

  vec4 fld = vec4(0.0);
  if (m < 0.999) fld = field(frag);
  vec3 col = fld.rgb;

  if (m > 0.001) {
    float cs = max(6.0, floor(res.y / 52.0));
    vec2 cell = floor(frag / cs);
    vec4 c = field((cell + 0.5) * cs);
    float g = smoothstep(0.03, 0.62, pow(clamp(dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0), 1.0 / 2.2));
    float bit = glyph(g, (frag - cell * cs) / cs * 2.0 - 1.0);
    vec3 ink = c.rgb * 2.2 + oklch(0.5, 0.15, hue);
    vec3 ascii = mix(oklch(0.07, 0.015, hue), ink, bit);
    col = mix(col, ascii, m);
    fld.a = mix(fld.a, c.a, m);
  }

  if (vcr > 0.5) {
    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(vec3(0.0, 0.08, 0.02), vec3(0.0, 1.0, 0.44), smoothstep(0.0, 0.6, lum));
    col = mix(col, vec3(1.0, 0.25, 0.21), smoothstep(0.6, 0.9, fld.a) * 0.8);
    col = floor(col * 5.0) / 5.0;
    col *= 0.78 + 0.22 * sin(frag.y * 3.14159);
  }

  // Grain is added after gamma encoding so it stays even across dark and bright areas.
  vec3 srgb = pow(max(col, vec3(0.0)), vec3(1.0 / 2.2));
  srgb += (hash(frag + fract(time)) - 0.5) * U[3].w;
  outColor = vec4(srgb, 1.0);
}
`

export const wgsl = /* wgsl */ `
struct Uniforms { u0: vec4f, u1: vec4f, u2: vec4f, u3: vec4f }
@group(0) @binding(0) var<uniform> U: Uniforms;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

fn rot(a: f32) -> mat2x2f { let c = cos(a); let s = sin(a); return mat2x2f(c, -s, s, c); }

fn hash(pIn: vec2f) -> f32 {
  var p = fract(pIn * vec2f(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

fn noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2f(1.0, 0.0)), u.x),
             mix(hash(i + vec2f(0.0, 1.0)), hash(i + vec2f(1.0, 1.0)), u.x), u.y);
}

fn fbm(pIn: vec2f) -> f32 {
  var p = pIn;
  var v = 0.0;
  var a = 0.5;
  let m = rot(0.5);
  for (var i = 0; i < 5; i++) {
    v += a * noise(p);
    p = m * p * 2.02 + vec2f(1.7, 9.2);
    a *= 0.5;
  }
  return v;
}

fn oklch(L: f32, C: f32, h: f32) -> vec3f {
  let hr = radians(h);
  let a = C * cos(hr);
  let b = C * sin(hr);
  let l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  let m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  let s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  let l = l_ * l_ * l_;
  let m = m_ * m_ * m_;
  let s = s_ * s_ * s_;
  return max(vec3f(
     4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s), vec3f(0.0));
}

// Returns the linear colour of the ink field at a fragment, plus |r| (used by VCR mode).
fn field(frag: vec2f) -> vec4f {
  let res = U.u0.xy;
  let scroll = U.u1.w;
  let hue = U.u2.x;
  let t = U.u2.z;

  let uv = (frag - 0.5 * res) / res.y;
  var p = uv * U.u2.w * (1.0 + scroll * 0.5);
  p.y -= scroll * 1.2;

  let q = vec2f(fbm(p + vec2f(0.0, t)), fbm(p + vec2f(5.2, 1.3) - t * 0.7));
  let r = vec2f(fbm(p + U.u3.x * q + vec2f(1.7, 9.2) + t * 0.5),
                fbm(p + U.u3.x * q + vec2f(8.3, 2.8) - t * 0.4));
  let f = fbm(p + U.u3.x * r);

  let vein = pow(1.0 - abs(2.0 * f - 1.0), U.u3.z);

  let base = oklch(0.12, 0.02, hue);
  let ink = oklch(0.3, 0.09, hue + 25.0 * q.x);
  let glow = oklch(0.88, 0.19, hue + 40.0 * r.y - 20.0);
  let acc = oklch(0.5, 0.2, hue + 140.0);

  var col = mix(base, ink, smoothstep(0.35, 0.85, f));
  col = mix(col, acc, smoothstep(0.75, 1.15, length(r)) * 0.6);
  col += glow * vein * (0.45 + 0.55 * q.y);

  col *= 1.0 - 0.45 * dot(uv, uv);
  col = mix(col, base * 0.8, smoothstep(0.0, 0.85, scroll) * 0.9);
  return vec4f(col, length(r));
}

// 5x5 bitmap glyphs, darkest to brightest: . : * o & 8 @ #
fn glyph(g: f32, pIn: vec2f) -> f32 {
  var n = 4096u;
  if (g > 0.08) { n = 65600u; }
  if (g > 0.16) { n = 332772u; }
  if (g > 0.26) { n = 15255086u; }
  if (g > 0.36) { n = 23385164u; }
  if (g > 0.48) { n = 15252014u; }
  if (g > 0.6) { n = 13199452u; }
  if (g > 0.72) { n = 11512810u; }
  let p = floor(pIn * vec2f(4.0, -4.0) + 2.5);
  if (p.x < 0.0 || p.x > 4.0 || p.y < 0.0 || p.y > 4.0) { return 0.0; }
  let a = u32(p.x + 5.0 * p.y);
  return f32((n >> a) & 1u);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let res = U.u0.xy;
  let mouse = U.u0.zw;
  let vel = U.u1.xy;
  let time = U.u1.z;
  let scroll = U.u1.w;
  let hue = U.u2.x;
  let vcr = U.u2.y;

  // WebGPU's framebuffer origin is top-left; flip to match GL.
  let frag = vec2f(pos.x, res.y - pos.y);
  let uv = (frag - 0.5 * res) / res.y;

  // Around the cursor, the field is re-rendered as ASCII art.
  let speed = min(length(vel), 3.0);
  let radius = U.u3.y * (0.22 + 0.06 * speed);
  let m = (1.0 - smoothstep(radius * 0.45, radius, length(uv - mouse)))
        * (1.0 - smoothstep(0.5, 1.0, scroll));

  var fld = vec4f(0.0);
  if (m < 0.999) { fld = field(frag); }
  var col = fld.rgb;

  if (m > 0.001) {
    let cs = max(6.0, floor(res.y / 52.0));
    let cell = floor(frag / cs);
    let c = field((cell + 0.5) * cs);
    let g = smoothstep(0.03, 0.62, pow(clamp(dot(c.rgb, vec3f(0.2126, 0.7152, 0.0722)), 0.0, 1.0), 1.0 / 2.2));
    let bit = glyph(g, (frag - cell * cs) / cs * 2.0 - 1.0);
    let ink = c.rgb * 2.2 + oklch(0.5, 0.15, hue);
    let ascii = mix(oklch(0.07, 0.015, hue), ink, bit);
    col = mix(col, ascii, m);
    fld.a = mix(fld.a, c.a, m);
  }

  if (vcr > 0.5) {
    let lum = dot(col, vec3f(0.2126, 0.7152, 0.0722));
    col = mix(vec3f(0.0, 0.08, 0.02), vec3f(0.0, 1.0, 0.44), smoothstep(0.0, 0.6, lum));
    col = mix(col, vec3f(1.0, 0.25, 0.21), smoothstep(0.6, 0.9, fld.a) * 0.8);
    col = floor(col * 5.0) / 5.0;
    col *= 0.78 + 0.22 * sin(frag.y * 3.14159);
  }

  // Grain is added after gamma encoding so it stays even across dark and bright areas.
  var srgb = pow(max(col, vec3f(0.0)), vec3f(1.0 / 2.2));
  srgb += (hash(frag + fract(time)) - 0.5) * U.u3.w;
  return vec4f(srgb, 1.0);
}
`
