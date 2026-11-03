/**
 * GLSL for the /experiments/hax background: a red, watery, VHS-glitched caustic field.
 * Ported in spirit from the 2021 tiled bg.gif.
 */

/** Fullscreen triangle generated from gl_VertexID, so no vertex buffers are needed. */
export const vertexSource = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`

export const fragmentSource = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;  // drawing buffer size in px
uniform float uScale;      // drawing buffer px per CSS px
uniform float uTime;       // seconds
uniform float uGlitch;     // 0..1 burst intensity
uniform float uSeed;       // changes every glitch step, picks new tear bands
uniform float uBeat;       // 1 right after the box blinks on, decays to 0
uniform vec3 uPointer;     // xy in 0..1 (y up), z = presence 0..1

out vec4 outColor;

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 r = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = r * p * 2.03;
    a *= 0.5;
  }
  return v;
}

// Iterated sine-warp caustics: sharp bright filaments on a dark field.
float caustic(vec2 p, float t) {
  vec2 i = p;
  float c = 1.0;
  const float inten = 0.005;
  for (int n = 0; n < 5; n++) {
    float tt = t * (1.0 - 3.5 / float(n + 1));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / inten), p.y / (cos(i.y + tt) / inten)));
  }
  c /= 5.0;
  c = 1.17 - pow(c, 1.4);
  return clamp(pow(abs(c), 8.0), 0.0, 1.6);
}

// The water: domain-warped, vertically squashed caustics like the gif's reflections.
float water(vec2 uv, float t) {
  float aspect = uResolution.x / uResolution.y;
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);

  // Pointer: a slow ring wave pushed out from the cursor.
  vec2 m = vec2((uPointer.x - 0.5) * aspect, uPointer.y - 0.5);
  vec2 d = p - m;
  float dl = length(d) + 1e-4;
  float ring = sin(dl * 28.0 - t * 5.0) * exp(-dl * 4.5) * uPointer.z;
  p += d / dl * ring * 0.035;

  vec2 q = vec2(fbm(p * 2.2 + vec2(0.0, t * 0.15)), fbm(p * 2.2 + vec2(5.2, -t * 0.12)));
  p += (q - 0.5) * 0.22;

  // Squash vertically so ripples stretch sideways, like light on a wavy surface.
  vec2 cp = vec2(p.x * 13.0, p.y * 24.0) - 250.0;
  float c = caustic(cp, t * 0.55 + 23.0);
  c += 0.35 * caustic(cp * 0.5 - 120.0, t * 0.35 + 3.0);
  c += exp(-dl * 6.0) * 0.35 * uPointer.z;
  return c;
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / uResolution;
  float t = uTime;
  float cssY = frag.y / uScale;

  // Always-on VHS wobble: tiny per-line jitter plus a slow rolling tracking band.
  float line = floor(cssY / 2.0);
  float jitter = (hash11(line + floor(t * 24.0) * 7.13) - 0.5) * 0.0015;
  float rollPos = fract(t * 0.07);
  float roll = smoothstep(0.035, 0.0, abs(uv.y - rollPos));
  uv.x += jitter + roll * 0.012 * sin(cssY * 0.6 + t * 30.0);

  // Glitch burst: random horizontal blocks shoved sideways.
  float tear = 0.0;
  if (uGlitch > 0.0) {
    float rows = mix(6.0, 28.0, hash11(uSeed * 3.1));
    float band = floor(uv.y * rows);
    float pick = hash21(vec2(band, uSeed));
    float on = step(1.0 - 0.45 * uGlitch, pick);
    tear = on * (hash21(vec2(band, uSeed + 9.0)) - 0.5) * 0.35 * uGlitch;
    // Fine shred lines inside the burst.
    float shred = step(0.93, hash21(vec2(floor(cssY / 3.0), uSeed + 2.0)));
    tear += shred * (hash11(cssY + uSeed) - 0.5) * 0.06 * uGlitch;
    uv.x += tear;
  }

  // Colour bleed: smeared channels sampled at different offsets.
  float split = 0.0025 + uGlitch * 0.03 + abs(tear) * 0.15;
  float r = water(uv, t);
  float g = water(uv + vec2(split, 0.0), t);
  float b = water(uv - vec2(split * 1.6, 0.0), t);

  // Monochrome red ramp: dark oxblood base, red filaments, hot pink-white peaks.
  float base = 0.5 + 0.12 * fbm(uv * 3.0 + t * 0.05);
  vec3 col;
  col.r = base + r * 0.9;
  // Offset samples only lift green and blue together, so the split stays monochrome red.
  float hot = 0.5 * (g * g + b * b);
  col.r += 0.18 * abs(g - b);
  col.gb = vec2(0.09 + 0.22 * hot + 0.06 * r * r * r);

  // Burst blocks get crushed and inverted-ish for that broken-tape look.
  if (abs(tear) > 0.0) {
    float k = step(0.6, hash21(vec2(floor(uv.y * 40.0), uSeed + 4.0)));
    col = mix(col, vec3(1.0, 0.18, 0.2) - col * vec3(0.5, 0.6, 0.6), k * 0.55 * uGlitch);
  }

  // Blink hit: a short flash when the box pops on.
  col *= 1.0 + uBeat * 0.18;

  // Scanlines locked to CSS pixels, plus the rolling band glow.
  float scan = 0.82 + 0.18 * sin(cssY * 3.14159);
  col *= scan;
  col += vec3(0.12, 0.02, 0.02) * roll;

  // Grain and vignette.
  float grain = hash21(frag + fract(t * 61.0) * 113.0) - 0.5;
  col += grain * vec3(1.0, 0.35, 0.35) * (0.06 + uGlitch * 0.1);
  vec2 v = uv - 0.5;
  col *= 1.0 - dot(v, v) * 1.1;

  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`
