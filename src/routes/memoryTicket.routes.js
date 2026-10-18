import express from "express";
import redis from "../lib/redis.js";
import { ticketQueue } from "../lib/bullQueue.js";
import { requireAuth, restrictTo } from "../middlewares/auth.js";

const router = express.Router();

const LUA_RESERVE_TICKET = `
  local seatKey = KEYS[1]
  local seats = tonumber(redis.call('get', seatKey) or '-1')

  if seats == -1 then
    return -2 -- Key not initialized
  elseif seats > 0 then
    redis.call('decr', seatKey)
    return 1  -- Reserved successfully
  else
    return 0  -- Sold out
  end
`;

router.post("/", requireAuth, restrictTo("CUSTOMER"), async (req, res) => {
  try {
    const { eventId } = req.body;
    const parsedEvnId = Number(eventId);

    if (!parsedEvnId || isNaN(parsedEvnId)) {
      return res.status(400).json({ success: false, message: "Invalid event ID format" });
    }

    const seatKey = `event:${parsedEvnId}:availSeats`;

    // 1. In-memory atomic check & decrement (<0.5ms)
    const result = await redis.eval(LUA_RESERVE_TICKET, 1, seatKey);

    // Uninitialized key protection
    if (result === -2) {
      return res.status(500).json({
        success: false,
        message: "Event inventory not initialized in memory",
      });
    }

    // 2. Fail fast: reject immediately without touching MySQL
    if (result === 0) {
      return res.status(409).json({ success: false, message: "Event is sold out" });
    }

    // 3. Success: Push minimal payload to queue (Zero DB calls here!)
    await ticketQueue.add("persist-ticket", {
      eventId: parsedEvnId,
      customerId: req.user.id,
      userEmail: req.user.email,
    });

    return res.status(202).json({
      success: true,
      message: "Ticket reserved successfully. Confirmation processing.",
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;