# Use the official Microsoft Playwright image that comes with Node.js and all browser system libraries pre-installed
FROM mcr.microsoft.com/playwright:v1.47.0-jammy

# Create and set working directory
WORKDIR /app

# Copy package descriptors
COPY package*.json ./

# Install dependencies (runs Playwright chromium download automatically)
RUN npm install

# Copy the rest of the application code
COPY . .

# Set environment variable for production port
ENV PORT=3000
EXPOSE 3000

# Start the node server
CMD ["node", "server.js"]
