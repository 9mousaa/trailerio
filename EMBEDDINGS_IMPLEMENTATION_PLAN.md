# Embeddings Implementation Plan

## Current State After IMDb ID Matching

✅ **IMDb ID matching implemented** - Solves 95%+ of cases
✅ **Field optimization** - 30% faster API calls
⚠️ **Remaining issue:** Items without IMDb IDs still use fuzzy matching (70-80% accuracy)

## Should We Add Embeddings?

### ✅ **YES - As a Smart Fallback**

**When embeddings help:**
- Items without IMDb IDs in Archive (~20-30% of cases)
- Short/generic titles ("Stephen", "Troll 2")
- Title variations that fuzzy matching misses
- Edge cases where fuzzy score is 0.7-0.9 (uncertain matches)

**When embeddings DON'T run:**
- IMDb ID exact match found (instant, perfect)
- Exact title match (instant, perfect)
- High fuzzy match >0.9 (already confident)

## Implementation Strategy

### Option 1: On-Demand Embeddings (Recommended)
- Generate embedding for search title when needed
- Compare against top 3-5 candidates from title search
- Rerank by semantic similarity
- **Overhead:** ~50ms per request (only when IMDb ID fails)

### Option 2: Pre-computed Embeddings (Future)
- Background job to sync Archive trailers
- Generate embeddings during sync
- Store in SQLite for instant lookup
- **Overhead:** Zero at runtime (but requires pre-indexing)

## Technical Details

### Library: `@xenova/transformers`
- Pure JavaScript (no Python)
- Model: `Xenova/all-MiniLM-L6-v2` (~80MB)
- Speed: ~10-50ms per embedding
- Memory: ~80MB model + ~5MB cache

### When to Use
1. **IMDb ID match?** → Use immediately (skip embeddings)
2. **Exact title match?** → Use immediately (skip embeddings)
3. **Fuzzy >0.9?** → Use immediately (skip embeddings)
4. **Fuzzy 0.7-0.9?** → Generate embeddings, rerank top 3-5
5. **Fuzzy <0.7?** → Skip (likely wrong)

## Expected Impact

**Accuracy improvement:**
- Items with IMDb ID: 95%+ (unchanged)
- Items without IMDb ID: 70-80% → 85-90% (+10-15%)

**Performance impact:**
- IMDb ID matches: 0ms (no change)
- Title matches: 0ms (no change)
- Fallback cases: +50ms (only when needed)

**Memory impact:**
- Model: ~80MB (loaded once, lazy)
- Runtime: ~5MB (embeddings cache)

## Recommendation

**Implement as optional fallback:**
- Only runs when IMDb ID matching fails
- Only for uncertain matches (fuzzy 0.7-0.9)
- Lightweight and fast
- Improves edge cases without hurting common path

