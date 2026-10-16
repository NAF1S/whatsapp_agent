-- Hide Haven Customer Support Agent — Supabase PostgreSQL Schema
-- Database: PostgreSQL 17.11 with pgvector 0.8.2

-- 1. Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Documents table for RAG (FAQs, Policies, Store info)
CREATE TABLE IF NOT EXISTS documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content TEXT NOT NULL,
    metadata JSONB DEFAULT '{}',
    embedding VECTOR(768),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for vector search on documents
CREATE INDEX IF NOT EXISTS idx_documents_embedding 
ON documents USING hnsw (embedding vector_cosine_ops);

-- 3. Customer Sessions (Tracks state machine & human handoff lock)
CREATE TABLE IF NOT EXISTS sessions (
    phone VARCHAR(30) PRIMARY KEY,
    customer_name VARCHAR(255),
    is_human_controlled BOOLEAN DEFAULT FALSE,
    human_agent_id VARCHAR(50),
    handoff_reason TEXT,
    handoff_at TIMESTAMPTZ,
    last_message_at TIMESTAMPTZ DEFAULT NOW(),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Messages History (Multi-turn conversations)
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone VARCHAR(30) NOT NULL REFERENCES sessions(phone) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'human', 'system')),
    content TEXT NOT NULL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_phone_created ON messages(phone, created_at DESC);

-- 5. Products Cache (Synced from WooCommerce with vector embeddings for semantic search)
CREATE TABLE IF NOT EXISTS products (
    id BIGINT PRIMARY KEY,
    name VARCHAR(500) NOT NULL,
    slug VARCHAR(500),
    sku VARCHAR(100),
    price DECIMAL(12, 2),
    regular_price DECIMAL(12, 2),
    stock_quantity INTEGER,
    stock_status VARCHAR(50),
    description TEXT,
    short_description TEXT,
    permalink TEXT,
    categories JSONB DEFAULT '[]',
    images JSONB DEFAULT '[]',
    embedding VECTOR(768),
    synced_at TIMESTAMPTZ DEFAULT NOW()
);

-- Full-text search index on product name and descriptions
CREATE INDEX IF NOT EXISTS idx_products_name_trgm ON products USING gin (to_tsvector('english', name || ' ' || COALESCE(short_description, '')));

-- Vector index on products
CREATE INDEX IF NOT EXISTS idx_products_embedding 
ON products USING hnsw (embedding vector_cosine_ops);

-- 6. Orders Cache & Logging (For fast order tracking)
CREATE TABLE IF NOT EXISTS customer_orders (
    id BIGINT PRIMARY KEY,
    order_key VARCHAR(100),
    status VARCHAR(50),
    currency VARCHAR(10),
    total DECIMAL(12, 2),
    customer_id BIGINT,
    billing JSONB DEFAULT '{}',
    shipping JSONB DEFAULT '{}',
    line_items JSONB DEFAULT '[]',
    tracking_number VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_customer_phone ON customer_orders ((billing->>'phone'));

-- 7. RPC function for matching documents (FAQ & Knowledge base)
CREATE OR REPLACE FUNCTION match_documents (
    query_embedding VECTOR(768),
    match_threshold FLOAT DEFAULT 0.65,
    match_count INT DEFAULT 5
)
RETURNS TABLE (
    id UUID,
    content TEXT,
    metadata JSONB,
    similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        d.id,
        d.content,
        d.metadata,
        1 - (d.embedding <=> query_embedding) AS similarity
    FROM documents d
    WHERE 1 - (d.embedding <=> query_embedding) > match_threshold
    ORDER BY d.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- 8. RPC function for matching products semantically
CREATE OR REPLACE FUNCTION match_products (
    query_embedding VECTOR(768),
    match_threshold FLOAT DEFAULT 0.60,
    match_count INT DEFAULT 6
)
RETURNS TABLE (
    id BIGINT,
    name VARCHAR(500),
    sku VARCHAR(100),
    price DECIMAL(12, 2),
    regular_price DECIMAL(12, 2),
    stock_quantity INT,
    stock_status VARCHAR(50),
    short_description TEXT,
    permalink TEXT,
    images JSONB,
    similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        p.id,
        p.name,
        p.sku,
        p.price,
        p.regular_price,
        p.stock_quantity,
        p.stock_status,
        p.short_description,
        p.permalink,
        p.images,
        1 - (p.embedding <=> query_embedding) AS similarity
    FROM products p
    WHERE p.embedding IS NOT NULL AND (1 - (p.embedding <=> query_embedding) > match_threshold)
    ORDER BY p.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;
