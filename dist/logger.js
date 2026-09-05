function ts() {
    return new Date().toISOString();
}
export const logger = {
    info: (...args) => console.log(`[${ts()}] [INFO]`, ...args),
    warn: (...args) => console.warn(`[${ts()}] [WARN]`, ...args),
    error: (...args) => console.error(`[${ts()}] [ERROR]`, ...args),
    trade: (...args) => console.log(`[${ts()}] [TRADE]`, ...args),
};
