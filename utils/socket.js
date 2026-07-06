const { Server } = require("socket.io");
const logger = require("./logger");

let io;

module.exports = {
  init: (httpServer) => {
    io = new Server(httpServer, {
      cors: {
        origin: "*", // Or map to allowedOrigins from app.js in production
        methods: ["GET", "POST"]
      }
    });

    io.on("connection", (socket) => {
      logger.info(`[Socket.io] Client connected: ${socket.id}`);

      // Example: A supervisor can join a room specific to their ward or zone
      // socket.on('join_ward', (wardId) => {
      //   socket.join(`ward_${wardId}`);
      // });

      socket.on("disconnect", () => {
        logger.info(`[Socket.io] Client disconnected: ${socket.id}`);
      });
    });

    logger.info("[Socket.io] Initialized successfully");
    return io;
  },
  
  getIO: () => {
    if (!io) {
      throw new Error("Socket.io has not been initialized!");
    }
    return io;
  }
};
