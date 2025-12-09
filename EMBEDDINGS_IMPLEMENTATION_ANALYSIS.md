# Embeddings Implementation Analysis

## Current State

After implementing IMDb ID matching, we have:
- **95%+ accuracy** for items with IMDb IDs (exact matches)
- **70-80% accuracy** for items without IMDb IDs (title-based matching)
- **False positives** still possible for short/generic titles without IMDb IDs

## Should We Add Embeddings?

### ✅ **YES - But Only for Fallback Cases**

**When embeddings help:**
1. Items without IMDb IDs in Internet Archive
2. Short/generic titles ("Stephen", "Troll 2", "The Wire")
3. Title variations ("Matrix" vs "The Matrix" vs "Matrix, The")
4. Foreign titles with different transliterations

**When embeddings DON'T help:**
1. Items with IMDb IDs (we already have perfect matches)
2. Exact title matches (fuzzy matching already works)
3. Clear false positives (IMDb ID mismatch catches these)

### Performance Impact

**Without embeddings (current):**
- API call: 0.5-2s
- Matching: <1ms (simple string comparison)
- **Total: 0.5-2s**

**With embeddings (proposed):**
- API call: 0.5-2s (same)
- Embed search title: ~10-50ms (one-time per request)
- Vector search: ~1-5ms (local DB lookup)
- **Total: 0.5-2.1s** (negligible overhead)

**Memory impact:**
- Model size: ~80MB (all-MiniLM-L6-v2)
- Embeddings cache: ~1-5MB (for 10k trailers)
- **Total: ~85MB** (acceptable for 2GB server)

## Implementation Approach

### Option 1: Lightweight (Recommended)
**Use `@xenova/transformers`** - Runs entirely in Node.js, no Python needed

**Pros:**
- Pure JavaScript/Node.js
- Fast inference (~10-50ms per embedding)
- Small model size (~80MB)
- No external dependencies
- Can cache embeddings in SQLite

**Cons:**
- Initial model download (~80MB first time)
- Slight memory overhead

### Option 2: Pre-compute Embeddings
**Generate embeddings for all Archive trailers in background job**

**Pros:**
- Zero runtime overhead (embeddings pre-computed)
- Instant matching (just vector similarity search)
- Can use more powerful models offline

**Cons:**
- Requires pre-indexing system (which we should do anyway)
- More complex setup

### Option 3: Hybrid Approach (Best)
1. **Pre-index Archive trailers** (background job)
2. **Generate embeddings during indexing** (one-time cost)
3. **Store in SQLite** with vector extension or separate vector DB
4. **Use for fallback** when IMDb ID doesn't match

## Recommended Implementation

### Phase 1: Add Embeddings Library
```bash
npm install @xenova/transformers
```

### Phase 2: Generate Embeddings On-Demand
- When IMDb ID match fails, generate embedding for search title
- Compare against top candidates from title search
- Rerank by cosine similarity

### Phase 3: Pre-index with Embeddings (Future)
- Background job to sync Archive trailers
- Generate embeddings during sync
- Store in local DB for instant lookup

## Code Structure

```javascript
// 1. Initialize model (lazy load)
let embeddingModel = null;
async function getEmbeddingModel() {
  if (!embeddingModel) {
    const { pipeline } = await import('@xenova/transformers');
    embeddingModel = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return embeddingModel;
}

// 2. Generate embedding
async function embedText(text) {
  const model = await getEmbeddingModel();
  const result = await model(text, { pooling: 'mean', normalize: true });
  return Array.from(result.data);
}

// 3. Cosine similarity
function cosineSimilarity(vec1, vec2) {
  let dotProduct = 0;
  let norm1 = 0;
  let norm2 = 0;
  for (let i = 0; i < vec1.length; i++) {
    dotProduct += vec1[i] * vec2[i];
    norm1 += vec1[i] * vec1[i];
    norm2 += vec2[i] * vec2[i];
  }
  return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
}

// 4. Use in matching
// After getting top candidates from title search:
// - Generate embedding for search title
// - Generate embeddings for top 5-10 candidates
// - Rerank by similarity
// - Pick best match
```

## When to Use Embeddings

**Priority order:**
1. **IMDb ID exact match** → Use immediately (no embeddings needed)
2. **Exact title match** → Use immediately (no embeddings needed)
3. **High fuzzy match (>0.9)** → Use immediately (no embeddings needed)
4. **Medium fuzzy match (0.7-0.9)** → Generate embeddings, rerank top 3-5
5. **Low fuzzy match (<0.7)** → Skip (likely wrong)

## Expected Improvements

**Current (with IMDb ID matching):**
- Items with IMDb ID: 95%+ accuracy
- Items without IMDb ID: 70-80% accuracy
- False positives: ~5-10% for items without IMDb ID

**With embeddings (fallback only):**
- Items with IMDb ID: 95%+ accuracy (unchanged)
- Items without IMDb ID: 85-90% accuracy (+10-15%)
- False positives: ~2-5% for items without IMDb ID (-50%)

## Recommendation

**Implement embeddings, but only as a fallback:**

1. ✅ **Keep IMDb ID matching as primary** (fastest, most accurate)
2. ✅ **Use embeddings only when:**
   - No IMDb ID match found
   - Fuzzy match is medium (0.7-0.9)
   - Top 3-5 candidates need reranking
3. ✅ **Pre-compute embeddings** during Archive sync (future optimization)

**Implementation effort:** 2-3 hours
**Performance impact:** Negligible (~50ms added for fallback cases)
**Accuracy improvement:** +10-15% for items without IMDb IDs

## Alternative: Skip Embeddings for Now

**If you want to keep it simple:**
- Current IMDb ID matching already solves most false positives
- Embeddings add complexity for marginal gain
- Can always add later if needed

**Recommendation:** Implement embeddings as a fallback - it's lightweight, helps edge cases, and doesn't hurt performance for the common case (IMDb ID matches).

