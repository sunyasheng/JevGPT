import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Path;
import org.apache.lucene.index.DirectoryReader;
import org.apache.lucene.store.FSDirectory;

/** Export raw contents.length() in Java/UTF-16 units, as used by the hybrid reader. */
public final class DocumentLengths {
    public static void main(String[] args) throws Exception {
        if (args.length != 1) throw new IllegalArgumentException("Usage: DocumentLengths <document-index>");
        var mapper = new ObjectMapper();
        try (var directory = FSDirectory.open(Path.of(args[0]));
             var reader = DirectoryReader.open(directory)) {
            for (var leaf : reader.leaves()) {
                var local = leaf.reader();
                var live = local.getLiveDocs();
                var stored = local.storedFields();
                for (int i = 0; i < local.maxDoc(); i++) {
                    if (live != null && !live.get(i)) continue;
                    var document = stored.document(i);
                    var raw = document.get("raw");
                    if (raw == null) throw new IllegalStateException("Index must store raw documents");
                    var contents = mapper.readTree(raw).path("contents").asText("");
                    System.out.println(document.get("id") + "\t" + contents.length());
                }
            }
        }
    }
}
