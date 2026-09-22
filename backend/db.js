const mysql = require('mysql2');
require('dotenv').config();

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Test de connexion automatique
pool.getConnection((err, connection) => {
    if (err) {
        console.error('❌ ERREUR DB :', err.message);
    } else {
        console.log(`✅ BASE DE DONNÉES CONNECTÉE : ${process.env.DB_NAME}`);
        connection.release();
    }
});

module.exports = pool.promise();
