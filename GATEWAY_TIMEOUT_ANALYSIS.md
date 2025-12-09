# Gateway Timeout Analysis

## Potential Causes

### 1. **Traefik Timeout < Backend Timeout**
- Backend timeout: 20 seconds (`STREAM_TIMEOUT`)
- Traefik default timeout: Usually 60s, but might be configured shorter
- **Issue**: If Traefik times out before backend, you get Gateway Timeout even if backend is working

### 2. **Database Blocking Operations**
- `better-sqlite3` uses WAL mode but writes can still block
- Multiple concurrent writes to `success_tracker` table can cause contention
- Database operations are synchronous and can block the event loop

### 3. **No Request Concurrency Limit**
- All requests process simultaneously
- With 2GB RAM, too many concurrent requests can cause:
  - Memory pressure
  - Slow garbage collection
  - Event loop blocking

### 4. **Response Not Being Sent**
- If an error occurs after `res.json()` is called but before response completes
- If `res.headersSent` check fails and response is never sent
- Promise rejection that isn't caught properly

### 5. **Memory Issues**
- 2GB RAM is tight for Node.js + SQLite + multiple concurrent requests
- Memory pressure causes:
  - Slow GC pauses
  - Event loop blocking
  - Overall slowdown

### 6. **Promise.race Edge Cases**
- If a promise never resolves/rejects, `Promise.race` won't help
- AbortController might not work if fetch is already in progress
- Database operations aren't cancellable

## Recommended Fixes

### Priority 1: Add Request Concurrency Limit
```javascript
// Limit concurrent requests to prevent overwhelming the system
const MAX_CONCURRENT_REQUESTS = 5;
let activeRequestCount = 0;
const requestQueue = [];

// Middleware to queue requests
app.use('/stream', (req, res, next) => {
  if (activeRequestCount >= MAX_CONCURRENT_REQUESTS) {
    // Queue the request
    requestQueue.push({ req, res, next });
  } else {
    activeRequestCount++;
    next();
  }
});
```

### Priority 2: Reduce Backend Timeout
- Current: 20 seconds
- Recommended: 15 seconds (to ensure Traefik doesn't timeout first)
- Individual sources: 10 seconds (down from 15)

### Priority 3: Make Database Operations Async
- Use `db.prepare().run()` in try-catch with timeout
- Consider batching database writes
- Add database operation timeout

### Priority 4: Add Health Check with Timeout Detection
- Monitor if requests are taking too long
- Alert when active requests > threshold
- Auto-restart if stuck

### Priority 5: Add Response Timeout Middleware
- Ensure all responses are sent within timeout
- Force close connections that exceed timeout
- Log stuck requests

### Priority 6: Optimize Memory Usage
- Reduce cache size
- More aggressive cleanup
- Monitor memory and restart if needed

## Quick Wins

1. **Reduce STREAM_TIMEOUT to 15s** - Ensures Traefik doesn't timeout first
2. **Add request queue** - Limit concurrent requests to 3-5
3. **Add response timeout middleware** - Force response within timeout
4. **Add database operation timeout** - Prevent DB from blocking
5. **Add memory monitoring** - Restart if memory > 1.5GB

