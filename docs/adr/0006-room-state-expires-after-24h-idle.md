# Room state persists in Durable Object storage and expires 24 h after the last message

A late joiner must receive the room's state even when no peer is live, and Durable Objects lose in-memory state on hibernation, so the last saved session lives in DO storage. Rooms that are never cleaned up would accumulate stored sessions forever, so an alarm deletes a room's storage 24 h after its last message; this also defines how long a join link lives. Rejected: memory-only (unreliable under hibernation) and no expiry (unbounded storage, stale links resurrecting old views).
