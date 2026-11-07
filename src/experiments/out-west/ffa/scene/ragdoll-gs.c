/*
 * Copyright (c) 2015 cannon.js Authors
 *
 * Permission is hereby granted, free of charge, to any person
 * obtaining a copy of this software and associated documentation
 * files (the "Software"), to deal in the Software without
 * restriction, including without limitation the rights to use, copy,
 * modify, merge, publish, distribute, sublicense, and/or sell copies
 * of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
 * LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
 * OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
 * WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
/* Exact Float64 iteration of ragdoll-solver.ts; no reassociation or fused operations.
 * Build: bun scripts/build-ragdoll-gs.ts (LLVM clang with a wasm32 target).
 * The row order and arithmetic are adapted from cannon-es 0.20.0, MIT license;
 * the complete upstream copyright and license are retained in ragdoll-solver.ts.
 */
static double dot(const double *r, int o, const double *v, int a) {
  return r[o] * v[a] + r[o + 1] * v[a + 1] + r[o + 2] * v[a + 2];
}
static void add(double *v, int a, const double *r, int o, double scale) {
  v[a] = v[a] + scale * r[o];
  v[a + 1] = v[a + 1] + scale * r[o + 1];
  v[a + 2] = v[a + 2] + scale * r[o + 2];
}
unsigned int gs_base(void) {
  extern unsigned char __heap_base;
  return (unsigned int)&__heap_base;
}
int gs_abi(void) { return 1; }
int gs_width(void) { return 24; }
int gs(int count, int limit, double tolerance, double *rows, const int *indices,
       double *velocity, const double *masses, const unsigned char *finite,
       int *stats) {
  int iteration = 0, zero = 0;
  for (; iteration < limit; iteration++) {
    double total = 0;
    for (int j = 0; j < count; j++) {
      int o = j * 24, ai = indices[j * 2], bi = indices[j * 2 + 1];
      int a = ai * 6, b = bi * 6;
      double gw = dot(rows, o, velocity, a) + dot(rows, o + 3, velocity, a + 3) +
                  (dot(rows, o + 6, velocity, b) + dot(rows, o + 9, velocity, b + 3));
      double lambda = rows[o + 23];
      double delta = rows[o + 19] * (rows[o + 18] - gw - rows[o + 20] * lambda);
      if (lambda + delta < rows[o + 21]) delta = rows[o + 21] - lambda;
      else if (lambda + delta > rows[o + 22]) delta = rows[o + 22] - lambda;
      rows[o + 23] = lambda + delta;
      total += __builtin_fabs(delta);
      if (delta == 0 && finite[j]) { zero++; continue; }
      add(velocity, a, rows, o, masses[ai] * delta);
      add(velocity, b, rows, o + 6, masses[bi] * delta);
      add(velocity, a + 3, rows, o + 12, delta);
      add(velocity, b + 3, rows, o + 15, delta);
    }
    if (total * total < tolerance * tolerance) break;
  }
  stats[0] = zero;
  return iteration;
}
