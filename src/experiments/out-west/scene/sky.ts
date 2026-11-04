/**
 * The sky dome, shared by the duel street and the Frontier: a gradient driven by the sun's
 * elevation, a sun disc bright enough to bloom with a Mie halo round it, drifting cumulus (the same
 * cloud field whose shadows cross the ground, atmos.ts) lit from the sun's side with dark
 * undersides, wind-combed cirrus above them, two ranges of mountains on the horizon in aerial
 * perspective, and at night stars, the milky way and the moon.
 *
 * The dome is drawn after the opaque scene at the far plane (depth test on), so only the pixels
 * the town leaves open pay for it. It ignores the camera's position (direction only).
 */
import {
  BackSide,
  Color,
  Mesh,
  type Object3D,
  ShaderMaterial,
  SphereGeometry,
  Uniform,
  Vector3,
} from 'three'
import { ATMOS, CLOUD_GLSL, HAZE_GLSL } from './atmos.ts'

const skyVert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  gl_Position = p.xyww;
}
`

const skyFrag = /* glsl */ `
${CLOUD_GLSL}
${HAZE_GLSL}
uniform vec3 zenith;
uniform vec3 horizon;
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform float sunGlow;
uniform float sunDisc;
uniform float stars;
uniform float moon;
uniform vec3 moonDir;
uniform float cloudLight;
uniform float detail;
uniform vec3 mtnFar;
uniform vec3 mtnNear;
varying vec3 vDir;

float h31(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }

// periodic ridge noise over the azimuth (sampled on a circle, so it never seams)
float ridge(float az, float k, float seed) {
  vec2 c = vec2(cos(az), sin(az)) * k + seed;
  float s = 0.0;
  float a = 0.55;
  for (int i = 0; i < 4; i++) {
    float n = atmNoise(c);
    s += a * (1.0 - abs(n * 2.0 - 1.0));
    c = c * 2.1 + 3.7;
    a *= 0.45;
  }
  return s;
}

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  float hh = max(h, 0.0);
  vec3 sd = normalize(sunDir);
  float s = dot(d, sd);
  float sp = max(s, 0.0);
  float day = smoothstep(-0.1, 0.12, sd.y);
  float low = 1.0 - smoothstep(0.02, 0.5, sd.y);

  // --- gradient: horizon to zenith, bright band at the horizon, the sun's side warmer
  vec3 col = mix(horizon, zenith, pow(smoothstep(0.0, 0.62, hh), 0.6));
  col += horizon * 0.18 * exp(-hh * 22.0);
  vec2 dh = normalize(d.xz + vec2(1e-5));
  vec2 sh = normalize(sd.xz + vec2(1e-5));
  float az = dot(dh, sh);
  col += sunColor * sunGlow * pow(max(az, 0.0), 3.0) * exp(-hh * 4.5) * low * 0.55 * day;
  // the anti-sun side at dusk: a dusky rose band over a blue earth shadow
  float anti = pow(max(-az, 0.0), 2.0) * low * day;
  col = mix(col, col * vec3(0.78, 0.82, 1.08), anti * exp(-hh * 30.0) * 0.6);
  col += vec3(0.35, 0.16, 0.2) * anti * exp(-pow((hh - 0.09) * 14.0, 2.0)) * 0.35 * sunGlow;

  // --- sun: halo, glow and a disc hot enough to bloom
  vec3 halo = sunColor * (pow(sp, 9.0) * 0.28 + pow(sp, 90.0) * 0.9 + pow(sp, 1400.0) * 3.0);
  col += halo * sunGlow * day;
  float disc = smoothstep(0.99962, 0.99978, s);
  col += sunColor * disc * sunDisc * step(-0.02, sd.y);

  // --- night: stars, the milky way, the moon
  if (stars > 0.0) {
    vec3 q = floor(d * 420.0);
    float r = h31(q);
    float tw = 0.65 + 0.35 * sin(atmTime * (2.0 + r * 5.0) + r * 60.0);
    float star = step(0.9972, r) * (0.5 + 0.5 * h31(q + 7.0)) * tw;
    star += step(0.99965, r) * 2.5;
    vec3 tint = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.88, 0.7), h31(q + 3.0));
    col += tint * star * stars * smoothstep(0.03, 0.3, h) * 1.3;
    // the milky way: a soft band of dust and glow across the sky
    vec3 mwN = normalize(vec3(0.55, 0.42, -0.72));
    float band = exp(-pow(dot(d, mwN) * 5.0, 2.0));
    float dust = atmFbm(d.xz / max(0.25, hh + 0.25) * 3.0 + d.y * 4.0);
    col += vec3(0.32, 0.36, 0.5) * band * smoothstep(0.35, 0.8, dust) * stars * 0.22 * smoothstep(0.05, 0.4, h);
  }
  if (moon > 0.0) {
    vec3 md = normalize(moonDir);
    float m = dot(d, md);
    float disc = smoothstep(0.99935, 0.99955, m);
    // a waxing gibbous: the lit side faces west, the maria are faint noise
    vec3 tang = normalize(cross(md, vec3(0.0, 1.0, 0.0)));
    float off = dot(d - md * m, tang) / 0.034;
    float lit = smoothstep(-0.55, -0.25, off);
    float maria = 0.8 + 0.2 * atmNoise((d.xz - md.xz) * 900.0);
    col += vec3(0.9, 0.93, 1.0) * disc * mix(0.06, 2.6 * maria, lit) * moon;
    col += vec3(0.35, 0.45, 0.85) * (pow(max(m, 0.0), 60.0) * 0.18 + pow(max(m, 0.0), 600.0) * 0.4) * moon;
  }

  // --- clouds: cumulus on a layer at 700 m, cirrus far above
  if (h > 0.0) {
    float t = ${'700.0'} / max(h, 0.028);
    vec2 p = d.xz * t;
    float dens = atmCloudAt(p);
    float fade = smoothstep(0.012, 0.16, h) * (1.0 - smoothstep(9000.0, 26000.0, t));
    if (dens > 0.001 && fade > 0.0) {
      // brighter where the sunward side thins out; dark bellies where it is thick
      float toward = atmCloudAt(p + sd.xz * 160.0);
      float lit = clamp(0.55 + (dens - toward) * 1.8, 0.0, 1.0);
      vec3 sky = mix(horizon, zenith, 0.45);
      vec3 bright = sunColor * cloudLight * (0.85 + 1.6 * pow(sp, 5.0)) + sky * 0.55;
      vec3 belly = sky * 0.62 + sunColor * cloudLight * 0.08;
      belly = mix(belly, belly * vec3(0.8, 0.78, 0.9), dens);
      vec3 cc = mix(belly, bright, lit);
      // silver lining toward the sun on thin edges
      cc += sunColor * cloudLight * pow(sp, 14.0) * (1.0 - dens) * 2.4;
      // the far clouds melt into the horizon haze
      cc = mix(atmHaze(d, sd), cc, smoothstep(0.0, 0.22, h) * 0.7 + 0.3);
      col = mix(col, cc, dens * fade * 0.94);
    }
    if (detail > 0.5) {
      vec2 q = d.xz * (2600.0 / max(h, 0.06));
      vec2 cq = vec2(q.x * 0.00035 - atmTime * 0.0045, q.y * 0.0019 - atmTime * 0.0012);
      float ci = atmFbm(cq + atmNoise(cq * 3.0) * 0.4);
      ci = smoothstep(0.55, 0.85, ci) * smoothstep(0.04, 0.25, h);
      vec3 cic = sunColor * cloudLight * (0.7 + pow(sp, 4.0) * 1.5) + zenith * 0.4;
      col = mix(col, cic, ci * 0.35);
    }
  }

  // --- mountains on the horizon: a far pale range and a nearer, darker one
  float a = atan(d.x, d.z);
  float rFar = 0.006 + 0.034 * ridge(a, 2.2, 11.0);
  float rNear = 0.002 + 0.02 * ridge(a + 1.3, 4.0, 37.0) * smoothstep(0.2, 0.6, atmNoise(vec2(cos(a), sin(a)) * 1.6 + 5.0));
  vec3 haze = atmHaze(d, sd);
  if (h < rFar) {
    float rim = smoothstep(rFar - 0.004, rFar, h) * low * pow(max(az, 0.0), 2.0);
    vec3 mc = mix(mtnFar, haze, 0.55 + 0.35 * smoothstep(rFar - 0.03, rFar, h) * 0.0);
    col = mc + sunColor * rim * 0.25 * day;
  }
  if (h < rNear) {
    col = mix(mtnNear, haze, 0.32 + 0.25 * (1.0 - smoothstep(-0.01, rNear, h)));
  }
  // below the horizon the dome is the haze (the ground covers it)
  col = mix(col, haze, smoothstep(0.0, -0.04, h));
  gl_FragColor = vec4(col, 1.0);
}
`

/** Uniform values a time-of-day preset sets on the sky. */
export interface SkyLook {
  zenith: Color
  horizon: Color
  sunDir: Vector3
  sunColor: Color
  sunGlow: number
  stars: number
  moon: number
}

export class Sky {
  readonly mesh: Mesh
  private readonly u = {
    zenith: new Uniform(new Color()),
    horizon: new Uniform(new Color()),
    sunDir: new Uniform(new Vector3(0, 1, 0)),
    sunColor: new Uniform(new Color()),
    sunGlow: new Uniform(0.5),
    sunDisc: new Uniform(40),
    stars: new Uniform(0),
    moon: new Uniform(0),
    moonDir: new Uniform(new Vector3(-0.4, 0.6, 0.7).normalize()),
    cloudLight: new Uniform(1),
    detail: new Uniform(1),
    mtnFar: new Uniform(new Color()),
    mtnNear: new Uniform(new Color()),
  }

  /** `detail` 0 drops the cirrus layer (the floor and legacy tiers). */
  constructor(parent: Object3D, detail: number) {
    this.u.detail.value = detail
    const mat = new ShaderMaterial({
      vertexShader: skyVert,
      fragmentShader: skyFrag,
      side: BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { ...this.u, ...ATMOS },
    })
    this.mesh = new Mesh(new SphereGeometry(10, 32, 16), mat)
    this.mesh.name = 'sky'
    this.mesh.frustumCulled = false
    // after the opaque scene: early depth rejects every pixel the town already covers
    this.mesh.renderOrder = 1000
    this.mesh.userData.noProbe = false
    parent.add(this.mesh)
  }

  set(look: SkyLook): void {
    const u = this.u
    u.zenith.value.copy(look.zenith)
    u.horizon.value.copy(look.horizon)
    u.sunDir.value.copy(look.sunDir)
    u.sunColor.value.copy(look.sunColor)
    u.sunGlow.value = look.sunGlow
    u.stars.value = look.stars
    u.moon.value = look.moon
    const night = look.moon > 0.5
    if (night) {
      u.moonDir.value.copy(look.sunDir)
    }
    // the disc burns at noon, sinks into the haze at the horizon, and is the moon's job at night
    const el = look.sunDir.y
    u.sunDisc.value = night ? 0 : 18 + 40 * Math.min(1, Math.max(0, el * 2))
    // cloud tops catch the sun by day, the moon's grey at night
    u.cloudLight.value = night ? 0.18 : 0.75 + 0.35 * Math.min(1, Math.max(0, el * 3))
    // mountain colours: dusty blue-violet by day, near-black blue at night, always in the haze
    const far = u.mtnFar.value
    far.copy(look.horizon).lerp(look.zenith, 0.35).multiplyScalar(0.82)
    const near = u.mtnNear.value
    near.copy(look.horizon).lerp(look.zenith, 0.5).multiplyScalar(0.55)
    near.lerp(new Color(0.18, 0.1, 0.08).multiplyScalar(night ? 0.2 : 1), 0.25)
    // the shared haze follows the sky
    ATMOS.atmHorizon.value.copy(look.horizon)
    ATMOS.atmZenith.value.copy(look.zenith)
    ATMOS.atmSunColor.value.copy(look.sunColor)
    ATMOS.atmSunDir.value.copy(look.sunDir)
    ATMOS.atmGlow.value = night ? 0 : look.sunGlow
  }
}
