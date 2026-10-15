import SwiftUI

struct SignInView: View {
  @Environment(Store.self) private var store
  @State private var hub = Session.hub?.absoluteString ?? ""
  @State private var email = ""
  @State private var password = ""
  @State private var busy = false
  @State private var error: String?
  @FocusState private var field: Field?

  enum Field { case hub, email, password }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 28) {
        VStack(alignment: .leading, spacing: 14) {
          Image("Mark")
            .resizable()
            .frame(width: 64, height: 64)
            .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
          Text("Sign in to Warren")
            .font(.largeTitle.bold())
          Text("Where people and agents work together.")
            .foregroundStyle(.secondary)
        }
        .padding(.top, 48)

        VStack(spacing: 14) {
          LabeledField(label: "Your Warren", hint: "The address you open Warren at, like warren.example.com or 100.90.1.2:4747") {
            TextField(text: $hub, prompt: Text(verbatim: "warren.example.com")) { Text("Your Warren") }
              .textContentType(.URL)
              .keyboardType(.URL)
              .textInputAutocapitalization(.never)
              .autocorrectionDisabled()
              .focused($field, equals: .hub)
              .submitLabel(.next)
              .onSubmit { field = .email }
          }
          LabeledField(label: "Email") {
            TextField(text: $email, prompt: Text(verbatim: "you@example.com")) { Text("Email") }
              .textContentType(.username)
              .keyboardType(.emailAddress)
              .textInputAutocapitalization(.never)
              .autocorrectionDisabled()
              .focused($field, equals: .email)
              .submitLabel(.next)
              .onSubmit { field = .password }
          }
          LabeledField(label: "Password") {
            SecureField("Password", text: $password)
              .textContentType(.password)
              .focused($field, equals: .password)
              .submitLabel(.go)
              .onSubmit(signIn)
          }
        }

        if let error {
          Label(error, systemImage: "exclamationmark.circle")
            .font(.callout)
            .foregroundStyle(.red)
        }

        Button(action: signIn) {
          Group {
            if busy { ProgressView().tint(Color(.systemBackground)) } else { Text("Sign in").fontWeight(.semibold) }
          }
          .frame(maxWidth: .infinity, minHeight: 50)
        }
        .buttonStyle(.plain)
        .foregroundStyle(Color(.systemBackground))
        .background(Capsule().fill(Color.primary))
        .disabled(busy || hub.isEmpty || email.isEmpty || password.isEmpty)
        .opacity(hub.isEmpty || email.isEmpty || password.isEmpty ? 0.5 : 1)

        Text("New to Warren? Set it up on a computer or server first (see github.com/eireijie/warren), then sign in here with the same account.")
          .font(.footnote)
          .foregroundStyle(.secondary)
      }
      .padding(.horizontal, 24)
      .frame(maxWidth: 480)
      .frame(maxWidth: .infinity)
    }
    .scrollDismissesKeyboard(.interactively)
  }

  private func signIn() {
    guard let url = API.normalize(hub) else {
      error = "That doesn't look like a web address."
      return
    }
    busy = true
    error = nil
    Task {
      do {
        try await store.signIn(hub: url, email: email.trimmingCharacters(in: .whitespaces), password: password)
      } catch {
        self.error = error.localizedDescription
      }
      busy = false
    }
  }
}

struct LabeledField<Content: View>: View {
  var label: String
  var hint: String?
  @ViewBuilder var content: Content

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(label).font(.subheadline.weight(.medium))
      content
        .padding(.horizontal, 14)
        .frame(minHeight: 48)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color(.secondarySystemBackground)))
      if let hint { Text(hint).font(.caption).foregroundStyle(.secondary) }
    }
  }
}
