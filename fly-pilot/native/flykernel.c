/* Hot loops for the male-CNS leaky integrate-and-fire network.
 *
 * Two kernels. fly_propagate walks the CSR rows of the neurons that spiked and
 * scatter-adds their signed weights; it is memory bound and single threaded on
 * purpose, because the scatter target is shared. fly_membrane fuses the whole
 * per-neuron update into one pass over the state arrays instead of the eight
 * separate numpy passes it replaces.
 */
#include <stdint.h>
#include <string.h>

#define EXPORT __declspec(dllexport)

/* xorshift128+, seeded per brain instance; used only for background drive. */
static uint64_t s0 = 0x9E3779B97F4A7C15ULL, s1 = 0xBF58476D1CE4E5B9ULL;

EXPORT void fly_seed(uint64_t a, uint64_t b) {
    s0 = a ? a : 0x9E3779B97F4A7C15ULL;
    s1 = b ? b : 0xBF58476D1CE4E5B9ULL;
}

static inline uint64_t xnext(void) {
    uint64_t x = s0, y = s1;
    s0 = y;
    x ^= x << 23;
    s1 = x ^ y ^ (x >> 17) ^ (y >> 26);
    return s1 + y;
}

/* out[] must be zeroed by the caller or by fly_propagate itself (zero != 0). */
EXPORT void fly_propagate(const int64_t *indptr, const int32_t *indices,
                          const float *w, const int64_t *fired,
                          int64_t n_fired, float *out, int64_t n, float gain,
                          int zero) {
    if (zero) memset(out, 0, (size_t)n * sizeof(float));
    for (int64_t k = 0; k < n_fired; ++k) {
        const int64_t i = fired[k];
        const int64_t a = indptr[i], b = indptr[i + 1];
        for (int64_t e = a; e < b; ++e) {
            out[indices[e]] += w[e] * gain;
        }
    }
}

/* One fused membrane update. Returns the number of neurons that fired and
 * fills fired[] with their indices. inject may be NULL. */
EXPORT int64_t fly_membrane(float *V, float *adapt, int16_t *refrac, float *rate,
                            const float *pending, const float *inject,
                            int64_t *fired, int64_t n,
                            const float *alpha, float v_rest, float v_thresh,
                            float v_reset, float adapt_decay, float adapt_step,
                            float rate_alpha, float rate_kick,
                            int64_t bg_k, float bg_mv,
                            float v_lo, float v_hi, int16_t refrac_steps) {
    const float rate_keep = 1.0f - rate_alpha;

    for (int64_t i = 0; i < n; ++i) {
        /* per-neuron membrane time constant: the optic lobe relies on slow and
         * fast cell types sitting side by side, which is what makes the T4/T5
         * motion detectors directional. */
        const float a = alpha[i];
        float v = V[i] * (1.0f - a) + a * v_rest + pending[i] - adapt[i];
        if (inject) v += inject[i];
        V[i] = v;
        adapt[i] *= adapt_decay;
        rate[i] *= rate_keep;
    }

    for (int64_t k = 0; k < bg_k; ++k) {
        V[(int64_t)(xnext() % (uint64_t)n)] += bg_mv;
    }

    int64_t nf = 0;
    for (int64_t i = 0; i < n; ++i) {
        float v = V[i];
        if (v < v_lo) v = v_lo;
        else if (v > v_hi) v = v_hi;

        int16_t r = refrac[i];
        if (r > 0) {
            refrac[i] = (int16_t)(r - 1);
            V[i] = v_reset;
            continue;
        }
        if (v >= v_thresh) {
            V[i] = v_reset;
            refrac[i] = refrac_steps;
            adapt[i] += adapt_step;
            rate[i] += rate_alpha * rate_kick;
            fired[nf++] = i;
        } else {
            V[i] = v;
        }
    }
    return nf;
}

/* Propagation with a per-presynaptic-cell delay.
 *
 * An elementary motion detector compares a fast input against a delayed one.
 * The delay is real: it comes from slow synaptic and cellular filtering in
 * Mi9, Mi4 and Tm9, the arms that are spatially offset from the T4/T5 centre.
 * Per-neuron membrane time constants do not reproduce it, because a cell held
 * above threshold fires as soon as input arrives whatever its tau -- measured
 * directly, the fast and slow arms came out 1.6 degrees apart in phase. So the
 * delay is represented explicitly, as in the classic correlator models.
 *
 * `ring` is ring_len buffers of n floats. A spike from cell i is deposited into
 * the buffer that will be consumed delay[i] steps from now. */
EXPORT void fly_propagate_delayed(const int64_t *indptr, const int32_t *indices,
                                  const float *w, const int64_t *fired,
                                  int64_t n_fired, float *ring, int64_t n,
                                  int64_t ring_len, int64_t t,
                                  const int16_t *delay, float gain) {
    for (int64_t k = 0; k < n_fired; ++k) {
        const int64_t i = fired[k];
        float *out = ring + ((t + (int64_t)delay[i]) % ring_len) * n;
        const int64_t a = indptr[i], b = indptr[i + 1];
        for (int64_t e = a; e < b; ++e) {
            out[indices[e]] += w[e] * gain;
        }
    }
}

/* Mean of rate[] over an index list, for the motor read-out. */
EXPORT float fly_group_mean(const float *rate, const int64_t *idx, int64_t k) {
    if (k <= 0) return 0.0f;
    double acc = 0.0;
    for (int64_t i = 0; i < k; ++i) acc += rate[idx[i]];
    return (float)(acc / (double)k);
}
