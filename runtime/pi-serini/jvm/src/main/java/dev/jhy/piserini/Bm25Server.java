package dev.jhy.piserini;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.anserini.search.ScoredDoc;
import io.anserini.search.SimpleSearcher;
import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.apache.lucene.analysis.standard.StandardAnalyzer;
import org.apache.lucene.queryparser.classic.QueryParser;
import org.apache.lucene.search.Query;

public final class Bm25Server {
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Pattern TOKEN_PATTERN = Pattern.compile("[A-Za-z0-9][A-Za-z0-9+._-]*");
    private static final Set<String> STOPWORDS = Set.of(
            "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "into", "is", "it",
            "of", "on", "or", "that", "the", "their", "this", "to", "with");

    private Bm25Server() {}

    public static void main(String[] args) throws Exception {
        Config config = Config.parse(args);
        long startedAt = System.nanoTime();
        long initStartedAt = System.nanoTime();
        try (SearcherPool searcherPool = SearcherPool.create(config.indexPath(), config.k1(), config.b(), config.threads())) {
            double initElapsedMs = nanosToMillis(System.nanoTime() - initStartedAt);
            if (config.transport().equals("tcp")) {
                serveTcp(searcherPool, config.host(), config.port(), startedAt, initElapsedMs, config.k1(), config.b(), config.threads());
                return;
            }
            serveStdio(searcherPool, startedAt, initElapsedMs);
        }
    }

    private static void serveStdio(SearcherPool searcherPool, long startedAt, double initElapsedMs) throws IOException {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
             BufferedWriter writer = new BufferedWriter(new OutputStreamWriter(System.out, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.isBlank()) {
                    continue;
                }
                Map<String, Object> response = processCommand(searcherPool, line, startedAt, initElapsedMs);
                writer.write(MAPPER.writeValueAsString(response));
                writer.write("\n");
                writer.flush();
            }
        }
    }

    private static void serveTcp(
            SearcherPool searcherPool,
            String host,
            int port,
            long startedAt,
            double initElapsedMs,
            double k1,
            double b,
            int threads)
            throws IOException {
        ExecutorService executor = Executors.newFixedThreadPool(threads);
        try (ServerSocket serverSocket = new ServerSocket()) {
            serverSocket.bind(new InetSocketAddress(host, port));
            int boundPort = serverSocket.getLocalPort();
            Map<String, Object> ready = new LinkedHashMap<>();
            ready.put("type", "server_ready");
            ready.put("transport", "tcp");
            ready.put("host", host);
            ready.put("port", boundPort);
            ready.put("bm25", Map.of("k1", round3(k1), "b", round3(b)));
            ready.put("threads", threads);
            ready.put("timing_ms", Map.of("init", round3(initElapsedMs)));
            System.out.println(MAPPER.writeValueAsString(ready));
            System.out.flush();

            while (true) {
                Socket socket = serverSocket.accept();
                executor.submit(() -> handleSocket(searcherPool, socket, startedAt, initElapsedMs));
            }
        } finally {
            executor.shutdown();
            try {
                if (!executor.awaitTermination(5, TimeUnit.SECONDS)) {
                    executor.shutdownNow();
                }
            } catch (InterruptedException error) {
                executor.shutdownNow();
                Thread.currentThread().interrupt();
            }
        }
    }

    private static void handleSocket(SearcherPool searcherPool, Socket socket, long startedAt, double initElapsedMs) {
        try (Socket closableSocket = socket;
             BufferedReader reader = new BufferedReader(new InputStreamReader(closableSocket.getInputStream(), StandardCharsets.UTF_8));
             BufferedWriter writer = new BufferedWriter(new OutputStreamWriter(closableSocket.getOutputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.isBlank()) {
                    continue;
                }
                Map<String, Object> response = processCommand(searcherPool, line, startedAt, initElapsedMs);
                writer.write(MAPPER.writeValueAsString(response));
                writer.write("\n");
                writer.flush();
            }
        } catch (IOException error) {
            System.err.println("BM25 TCP client handler failed: " + error.getMessage());
        }
    }

    private static Map<String, Object> processCommand(
            SearcherPool searcherPool,
            String line,
            long startedAt,
            double initElapsedMs) {
        Object commandId = null;
        String commandType = "unknown";
        try {
            Map<String, Object> command = MAPPER.readValue(line, new TypeReference<Map<String, Object>>() {});
            commandId = command.get("id");
            Object rawType = command.get("type");
            if (rawType instanceof String raw && !raw.isBlank()) {
                commandType = raw;
            }
            Map<String, Object> result = handleCommand(searcherPool, command, startedAt, initElapsedMs);
            Map<String, Object> response = new LinkedHashMap<>();
            response.put("id", commandId);
            response.put("type", "response");
            response.put("command", commandType);
            response.put("success", true);
            response.put("data", result);
            return response;
        } catch (Exception error) {
            Map<String, Object> response = new LinkedHashMap<>();
            response.put("id", commandId);
            response.put("type", "response");
            response.put("command", commandType);
            response.put("success", false);
            response.put("error", error.getMessage());
            return response;
        }
    }

    private static Map<String, Object> handleCommand(
            SearcherPool searcherPool,
            Map<String, Object> command,
            long startedAt,
            double initElapsedMs) throws Exception {
        long commandStartedAt = System.nanoTime();
        String commandType = requireString(command.get("type"), "Command must include a non-empty string 'type'.");
        try (BorrowedSearcher borrowedSearcher = searcherPool.borrow()) {
            SimpleSearcher searcher = borrowedSearcher.searcher();
            Map<String, Object> payload;
            switch (commandType) {
                case "search" -> payload = handleSearch(searcher, command);
                case "render_search_results" -> payload = handleRenderSearchResults(searcher, command);
                case "read_document" -> payload = handleReadDocument(searcher, command);
                case "ping" -> payload = new LinkedHashMap<>(Map.of("ok", true));
                default -> throw new IllegalArgumentException("Unknown command type: " + commandType);
            }
            attachTiming(payload, startedAt, initElapsedMs, commandStartedAt);
            return payload;
        }
    }

    private static Map<String, Object> handleSearch(SimpleSearcher searcher, Map<String, Object> command) throws Exception {
        String query = requireString(command.get("query"), "search requires a non-empty string query");
        String queryMode = optionalString(command.get("query_mode"), "plain");
        int k = optionalInt(command.get("k"), 5, "search k must be a positive integer");
        List<Clue> rerankClues = parseClues(command.get("rerank_clues"));

        ScoredDoc[] hits;
        if (queryMode.equals("lucene")) {
            QueryParser parser = new QueryParser("contents", new StandardAnalyzer());
            Query parsedQuery = parser.parse(query);
            hits = searcher.search(parsedQuery, k);
        } else if (queryMode.equals("plain")) {
            hits = searcher.search(query, k);
        } else {
            throw new IllegalArgumentException("search query_mode must be 'plain' or 'lucene'");
        }

        List<Map<String, Object>> results = new ArrayList<>();
        for (ScoredDoc hit : hits) {
            DocumentData document = readDocumentData(searcher, hit.docid);
            double rerankBonus = rerankScore(document, rerankClues);
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("docid", hit.docid);
            row.put("score", round3(hit.score + rerankBonus));
            row.put("_base_score", hit.score);
            row.put("_rerank_bonus", round3(rerankBonus));
            results.add(row);
        }
        results.sort(Comparator.<Map<String, Object>>comparingDouble(row -> ((Number) row.get("score")).doubleValue()).reversed());
        if (results.size() > k) {
            results = new ArrayList<>(results.subList(0, k));
        }

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("mode", "search");
        payload.put("query", query);
        payload.put("query_mode", queryMode);
        payload.put("k", k);
        payload.put("rerank_clues", serializeClues(rerankClues));
        payload.put("results", stripInternalScores(results));
        return payload;
    }

    private static List<Map<String, Object>> stripInternalScores(List<Map<String, Object>> rows) {
        List<Map<String, Object>> stripped = new ArrayList<>();
        for (Map<String, Object> row : rows) {
            Map<String, Object> cleaned = new LinkedHashMap<>();
            cleaned.put("docid", row.get("docid"));
            cleaned.put("score", row.get("score"));
            stripped.add(cleaned);
        }
        return stripped;
    }

    private static Map<String, Object> handleRenderSearchResults(SimpleSearcher searcher, Map<String, Object> command)
            throws Exception {
        List<String> docids = parseDocids(command.get("docids"));
        int snippetMaxChars = optionalInt(
                command.get("snippet_max_chars"),
                220,
                "render_search_results snippet_max_chars must be a positive integer");
        boolean inlineHighlights = optionalBoolean(
                command.get("inline_highlights"),
                true,
                "render_search_results inline_highlights must be a boolean");
        List<Clue> highlightClues = parseClues(command.get("highlight_clues"));

        List<Map<String, Object>> results = new ArrayList<>();
        for (String docid : docids) {
            DocumentData document = readDocumentData(searcher, docid);
            if (document == null) {
                Map<String, Object> missing = new LinkedHashMap<>();
                missing.put("docid", docid);
                missing.put("title", null);
                missing.put("matched_terms", List.of());
                missing.put("excerpt", "[Document not found]");
                missing.put("excerpt_truncated", false);
                results.add(missing);
                continue;
            }
            Preview preview = buildPreview(document, highlightClues, snippetMaxChars, inlineHighlights);
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("docid", docid);
            row.put("title", preview.title());
            row.put("matched_terms", preview.matchedTerms());
            row.put("excerpt", preview.excerpt());
            row.put("excerpt_truncated", preview.excerptTruncated());
            results.add(row);
        }

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("mode", "render_search_results");
        payload.put("docids", docids);
        payload.put("highlight_clues", serializeClues(highlightClues));
        payload.put("inline_highlights", inlineHighlights);
        payload.put("results", results);
        return payload;
    }

    private static Map<String, Object> handleReadDocument(SimpleSearcher searcher, Map<String, Object> command)
            throws Exception {
        String docid = requireString(command.get("docid"), "read_document requires a non-empty string docid");
        int offset = optionalInt(command.get("offset"), 1, "read_document offset must be a positive integer");
        int limit = optionalInt(command.get("limit"), 200, "read_document limit must be a positive integer");
        DocumentData document = readDocumentData(searcher, docid);

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("mode", "read_document");
        payload.put("docid", docid);
        if (document == null) {
            payload.put("found", false);
            payload.put("error", "Document with docid '" + docid + "' not found");
            return payload;
        }

        ReadChunk chunk = readDocumentChunk(document.contents(), offset, limit);
        payload.put("found", true);
        payload.put("offset", chunk.offset());
        payload.put("limit", chunk.limit());
        payload.put("total_lines", chunk.totalLines());
        payload.put("returned_line_start", chunk.returnedLineStart());
        payload.put("returned_line_end", chunk.returnedLineEnd());
        payload.put("truncated", chunk.truncated());
        payload.put("next_offset", chunk.nextOffset());
        payload.put("text", chunk.text());
        return payload;
    }

    private static void attachTiming(
            Map<String, Object> payload,
            long startedAt,
            double initElapsedMs,
            long commandStartedAt) {
        Map<String, Object> timing = new LinkedHashMap<>();
        timing.put("command", round3(nanosToMillis(System.nanoTime() - commandStartedAt)));
        timing.put("server_uptime", round3(nanosToMillis(System.nanoTime() - startedAt)));
        timing.put("init", round3(initElapsedMs));
        payload.put("timing_ms", timing);
    }

    private static DocumentData readDocumentData(SimpleSearcher searcher, String docid) throws Exception {
        String raw = searcher.doc_raw(docid);
        if (raw == null || raw.isBlank()) {
            return null;
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> rawJson = MAPPER.readValue(raw, new TypeReference<Map<String, Object>>() {});
        String contents = optionalString(rawJson.get("contents"), "");
        String title = firstNonBlank(
                optionalString(rawJson.get("title"), null),
                optionalString(rawJson.get("name"), null),
                optionalString(rawJson.get("headline"), null));
        return new DocumentData(docid, title, contents, rawJson);
    }

    private static Preview buildPreview(
            DocumentData document,
            List<Clue> clues,
            int snippetMaxChars,
            boolean inlineHighlights) {
        String title = document.title();
        String haystack = ((title == null ? "" : title + "\n") + document.contents());
        List<String> matchedTerms = collectMatchedTerms(haystack, clues);
        String excerpt = buildExcerpt(document.contents(), matchedTerms, snippetMaxChars);
        boolean truncated = excerpt.length() < document.contents().length();
        if (inlineHighlights && !matchedTerms.isEmpty()) {
            excerpt = applyInlineHighlights(excerpt, matchedTerms);
            if (title != null) {
                title = applyInlineHighlights(title, matchedTerms);
            }
        }
        return new Preview(title, matchedTerms, excerpt, truncated);
    }

    private static String buildExcerpt(String contents, List<String> matchedTerms, int snippetMaxChars) {
        String normalized = contents == null ? "" : contents.trim();
        if (normalized.isEmpty()) {
            return "";
        }
        int start = 0;
        if (!matchedTerms.isEmpty()) {
            String lower = normalized.toLowerCase(Locale.ROOT);
            int bestIndex = Integer.MAX_VALUE;
            for (String term : matchedTerms) {
                int candidate = lower.indexOf(term.toLowerCase(Locale.ROOT));
                if (candidate >= 0 && candidate < bestIndex) {
                    bestIndex = candidate;
                }
            }
            if (bestIndex != Integer.MAX_VALUE) {
                start = Math.max(0, bestIndex - Math.max(20, snippetMaxChars / 4));
            }
        }
        int end = Math.min(normalized.length(), start + snippetMaxChars);
        String snippet = normalized.substring(start, end).trim();
        if (start > 0) {
            snippet = "..." + snippet;
        }
        if (end < normalized.length()) {
            snippet = snippet + "...";
        }
        return snippet;
    }

    private static String applyInlineHighlights(String text, List<String> matchedTerms) {
        String highlighted = text;
        List<String> orderedTerms = new ArrayList<>(matchedTerms);
        orderedTerms.sort(Comparator.comparingInt(String::length).reversed());
        for (String term : orderedTerms) {
            if (term.isBlank()) {
                continue;
            }
            highlighted = highlighted.replaceAll(
                    "(?i)" + Pattern.quote(term),
                    Matcher.quoteReplacement("[[" + term + "]]"));
        }
        return highlighted;
    }

    private static List<String> collectMatchedTerms(String text, List<Clue> clues) {
        if (text == null || text.isBlank() || clues.isEmpty()) {
            return List.of();
        }
        String lower = text.toLowerCase(Locale.ROOT);
        LinkedHashSet<String> matched = new LinkedHashSet<>();
        for (Clue clue : clues) {
            for (String token : clue.tokens()) {
                if (token.length() < 2) {
                    continue;
                }
                if (lower.contains(token.toLowerCase(Locale.ROOT))) {
                    matched.add(token);
                }
            }
        }
        return new ArrayList<>(matched);
    }

    private static double rerankScore(DocumentData document, List<Clue> clues) {
        if (document == null || clues.isEmpty()) {
            return 0;
        }
        String lower = (((document.title() == null ? "" : document.title() + "\n") + document.contents())
                .toLowerCase(Locale.ROOT));
        double bonus = 0;
        for (Clue clue : clues) {
            if (clue.tokens().isEmpty()) {
                continue;
            }
            boolean matchedAll = true;
            int matchedTokens = 0;
            for (String token : clue.tokens()) {
                if (lower.contains(token.toLowerCase(Locale.ROOT))) {
                    matchedTokens += 1;
                } else {
                    matchedAll = false;
                }
            }
            if (matchedTokens == 0) {
                continue;
            }
            double clueWeight = clue.category().equals("required") ? 0.75 : 0.35;
            if (matchedAll) {
                bonus += clueWeight * clue.boost();
            } else {
                bonus += clueWeight * clue.boost() * ((double) matchedTokens / clue.tokens().size()) * 0.5;
            }
        }
        return bonus;
    }

    private static List<String> parseDocids(Object rawDocids) {
        if (!(rawDocids instanceof List<?> values)) {
            throw new IllegalArgumentException("render_search_results docids must be a JSON array of strings");
        }
        List<String> docids = new ArrayList<>();
        for (Object value : values) {
            docids.add(requireString(value, "render_search_results docids must contain only strings"));
        }
        return docids;
    }

    private static List<Clue> parseClues(Object rawClues) {
        if (rawClues == null) {
            return List.of();
        }
        if (!(rawClues instanceof List<?> values)) {
            throw new IllegalArgumentException("clues must be a JSON array");
        }
        List<Clue> clues = new ArrayList<>();
        for (Object value : values) {
            if (!(value instanceof Map<?, ?> rawMap)) {
                continue;
            }
            String text = requireString(rawMap.get("text"), "clue text must be a non-empty string");
            String category = optionalString(rawMap.get("category"), "any");
            if (!category.equals("required") && !category.equals("any")) {
                category = "any";
            }
            double boost = optionalDouble(rawMap.get("boost"), 1.0);
            List<String> tokens = tokenize(text);
            clues.add(new Clue(text, category, boost, tokens));
        }
        return clues;
    }

    private static List<Map<String, Object>> serializeClues(List<Clue> clues) {
        List<Map<String, Object>> serialized = new ArrayList<>();
        for (Clue clue : clues) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("text", clue.text());
            row.put("category", clue.category());
            row.put("boost", clue.boost());
            serialized.add(row);
        }
        return serialized;
    }

    private static List<String> tokenize(String text) {
        LinkedHashSet<String> tokens = new LinkedHashSet<>();
        Matcher matcher = TOKEN_PATTERN.matcher(text);
        while (matcher.find()) {
            String token = matcher.group().toLowerCase(Locale.ROOT);
            if (STOPWORDS.contains(token)) {
                continue;
            }
            tokens.add(token);
        }
        return new ArrayList<>(tokens);
    }

    private static ReadChunk readDocumentChunk(String text, int offset, int limit) {
        int normalizedOffset = Math.max(offset, 1);
        int normalizedLimit = Math.max(limit, 1);
        String[] lines = text.split("\\R", -1);
        int totalLines = lines.length;
        int startIndex = Math.min(normalizedOffset - 1, totalLines);
        int endIndex = Math.min(startIndex + normalizedLimit, totalLines);
        List<String> selected = new ArrayList<>();
        for (int i = startIndex; i < endIndex; i += 1) {
            selected.add(lines[i]);
        }
        int returnedLineStart = totalLines > 0 && startIndex < totalLines ? startIndex + 1 : 0;
        int returnedLineEnd = totalLines > 0 && startIndex < totalLines ? endIndex : 0;
        boolean truncated = endIndex < totalLines;
        Integer nextOffset = truncated ? endIndex + 1 : null;
        return new ReadChunk(
                normalizedOffset,
                normalizedLimit,
                totalLines,
                returnedLineStart,
                returnedLineEnd,
                truncated,
                nextOffset,
                String.join("\n", selected));
    }

    private static String requireString(Object value, String errorMessage) {
        if (!(value instanceof String text) || text.isBlank()) {
            throw new IllegalArgumentException(errorMessage);
        }
        return text;
    }

    private static String optionalString(Object value, String defaultValue) {
        if (value instanceof String text) {
            return text;
        }
        return defaultValue;
    }

    private static int optionalInt(Object value, int defaultValue, String errorMessage) {
        if (value == null) {
            return defaultValue;
        }
        if (value instanceof Number number) {
            int parsed = number.intValue();
            if (parsed <= 0) {
                throw new IllegalArgumentException(errorMessage);
            }
            return parsed;
        }
        throw new IllegalArgumentException(errorMessage);
    }

    private static boolean optionalBoolean(Object value, boolean defaultValue, String errorMessage) {
        if (value == null) {
            return defaultValue;
        }
        if (value instanceof Boolean flag) {
            return flag;
        }
        throw new IllegalArgumentException(errorMessage);
    }

    private static double optionalDouble(Object value, double defaultValue) {
        if (value == null) {
            return defaultValue;
        }
        if (value instanceof Number number) {
            return number.doubleValue();
        }
        return defaultValue;
    }

    private static String firstNonBlank(String... values) {
        for (String value : values) {
            if (value != null && !value.isBlank()) {
                return value;
            }
        }
        return null;
    }

    private static double nanosToMillis(long nanos) {
        return nanos / 1_000_000.0;
    }

    private static double round3(double value) {
        return Math.round(value * 1000.0) / 1000.0;
    }

    private record Config(Path indexPath, String transport, String host, int port, double k1, double b, int threads) {
        static Config parse(String[] args) {
            Map<String, String> values = new HashMap<>();
            for (int i = 0; i < args.length; i += 2) {
                if (i + 1 >= args.length || !args[i].startsWith("--")) {
                    throw new IllegalArgumentException("Arguments must be passed as --key value pairs");
                }
                values.put(args[i].substring(2), args[i + 1]);
            }
            Path indexPath = Path.of(values.getOrDefault("index-path", "indexes/browsecomp-plus-bm25-tevatron"));
            String transport = values.getOrDefault("transport", "stdio");
            String host = values.getOrDefault("host", "127.0.0.1");
            int port = Integer.parseInt(values.getOrDefault("port", "0"));
            double k1 = Double.parseDouble(values.getOrDefault("k1", "0.9"));
            double b = Double.parseDouble(values.getOrDefault("b", "0.4"));
            int threads = Integer.parseInt(values.getOrDefault("threads", "1"));
            if (threads <= 0) {
                throw new IllegalArgumentException("threads must be a positive integer");
            }
            return new Config(indexPath, transport, host, port, k1, b, threads);
        }
    }

    private record Clue(String text, String category, double boost, List<String> tokens) {}

    private record DocumentData(String docid, String title, String contents, Map<String, Object> raw) {}

    private record Preview(String title, List<String> matchedTerms, String excerpt, boolean excerptTruncated) {}

    private record ReadChunk(
            int offset,
            int limit,
            int totalLines,
            int returnedLineStart,
            int returnedLineEnd,
            boolean truncated,
            Integer nextOffset,
            String text) {}

    private static final class SearcherPool implements AutoCloseable {
        private final BlockingQueue<SimpleSearcher> available;
        private final List<SimpleSearcher> allSearchers;

        private SearcherPool(BlockingQueue<SimpleSearcher> available, List<SimpleSearcher> allSearchers) {
            this.available = available;
            this.allSearchers = allSearchers;
        }

        static SearcherPool create(Path indexPath, double k1, double b, int threads) throws IOException {
            BlockingQueue<SimpleSearcher> available = new LinkedBlockingQueue<>(threads);
            List<SimpleSearcher> allSearchers = new ArrayList<>(threads);
            try {
                for (int i = 0; i < threads; i += 1) {
                    SimpleSearcher searcher = new SimpleSearcher(indexPath.toString());
                    searcher.set_bm25((float) k1, (float) b);
                    available.put(searcher);
                    allSearchers.add(searcher);
                }
            } catch (Exception error) {
                for (SimpleSearcher searcher : allSearchers) {
                    try {
                        searcher.close();
                    } catch (Exception closeError) {
                        error.addSuppressed(closeError);
                    }
                }
                if (error instanceof IOException ioError) {
                    throw ioError;
                }
                if (error instanceof InterruptedException interruptedError) {
                    Thread.currentThread().interrupt();
                    throw new IOException("Interrupted while initializing BM25 searcher pool", interruptedError);
                }
                throw new IOException("Failed to initialize BM25 searcher pool", error);
            }
            return new SearcherPool(available, allSearchers);
        }

        BorrowedSearcher borrow() throws InterruptedException {
            return new BorrowedSearcher(this, available.take());
        }

        private void release(SimpleSearcher searcher) {
            try {
                available.put(searcher);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new RuntimeException("Interrupted while returning BM25 searcher to pool", error);
            }
        }

        @Override
        public void close() throws IOException {
            IOException failure = null;
            for (SimpleSearcher searcher : allSearchers) {
                try {
                    searcher.close();
                } catch (IOException error) {
                    if (failure == null) {
                        failure = error;
                    } else {
                        failure.addSuppressed(error);
                    }
                }
            }
            if (failure != null) {
                throw failure;
            }
        }
    }

    private static final class BorrowedSearcher implements AutoCloseable {
        private final SearcherPool owner;
        private final SimpleSearcher searcher;
        private boolean closed;

        private BorrowedSearcher(SearcherPool owner, SimpleSearcher searcher) {
            this.owner = owner;
            this.searcher = searcher;
        }

        SimpleSearcher searcher() {
            return searcher;
        }

        @Override
        public void close() {
            if (closed) {
                return;
            }
            closed = true;
            owner.release(searcher);
        }
    }
}
